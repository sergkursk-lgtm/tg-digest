package com.tglocaldigest.data.network

import android.content.Context
import android.util.Log
import com.tglocaldigest.data.model.CachedMessage
import com.tglocaldigest.data.model.TopicInfo
import com.tglocaldigest.utils.FileUtils
import com.tglocaldigest.utils.SecurePreferences
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.drinkless.td.libcore.telegram.*
import java.io.File

/**
 * TDLib менеджер для работы с Telegram API
 * Обрабатывает авторизацию, получение сообщений и управление чатами
 */
class TdLibManager private constructor(
    private val context: Context
) : TdClient.ClientResultHandler {
    
    private var client: TdApi.Client? = null
    private var authorizationState: AuthorizationState? = null
    private var isAuthorized = false
    
    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState
    
    private val _authState = MutableStateFlow(AuthState.INITIAL)
    val authState: StateFlow<AuthState> = _authState
    
    private val clientIdCounter = AtomicInteger(0)
    
    // Callbacks для обработки обновлений
    private var onMessageReceived: ((TdApi.Message) -> Unit)? = null
    private var onAuthorizationStateChanged: ((TdApi.AuthorizationState) -> Unit)? = null
    
    init {
        loadNativeLibrary()
        createClient()
    }
    
    private fun loadNativeLibrary() {
        try {
            System.loadLibrary("tdjni")
            Log.d(TAG, "TDLib native library loaded successfully")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "Failed to load TDLib native library", e)
            throw RuntimeException("Cannot load TDLib native library", e)
        }
    }
    
    private fun createClient() {
        try {
            val tdlibParameters = TdApi.TdlibParameters().apply {
                databaseDirectory = FileUtils.getTdlibDirectory(context).absolutePath
                useMessageDatabase = true
                useChatInfoDatabase = true
                useFileDatabase = true
                useStorageOptimizer = true
                ignoreFileNames = false
                apiId = BuildConfig.API_ID
                apiHash = BuildConfig.API_HASH
                systemLanguage = "en"
                deviceModel = "Android"
                systemVersion = android.os.Build.VERSION.RELEASE
                applicationVersion = BuildConfig.VERSION_NAME
                enableStorageStats = false
                testMode = false
                isLogVerbosityLevel = false
            }
            
            val logVerbosityLevel = if (BuildConfig.DEBUG) 2 else 0
            
            client = TdClient.create(
                clientIdCounter.incrementAndGet(),
                object : TdClient.ResultHandler {
                    override fun onResult(result: TdApi.BaseObject?) {
                        handleUpdate(result)
                    }
                },
                tdlibParameters,
                logVerbosityLevel
            )
            
            Log.d(TAG, "TDLib client created successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create TDLib client", e)
            _connectionState.value = ConnectionState.ERROR
        }
    }
    
    private fun handleUpdate(result: TdApi.BaseObject?) {
        when (result) {
            is TdApi.UpdateAuthorizationState -> {
                authorizationState = result.authorizationState
                onAuthorizationStateChanged?.invoke(result.authorizationState)
                handleAuthorizationState(result.authorizationState)
            }
            is TdApi.UpdateNewMessage -> {
                onMessageReceived?.invoke(result.message)
                cacheMessage(result.message)
            }
            is TdApi.UpdateNewChatMessage -> {
                onMessageReceived?.invoke(result.message)
                cacheMessage(result.message)
            }
            is TdApi.UpdateConnectionState -> {
                _connectionState.value = when (result.state) {
                    is TdApi.ConnectionStateConnecting -> ConnectionState.CONNECTING
                    is TdApi.ConnectionStateReady -> ConnectionState.CONNECTED
                    is TdApi.ConnectionStateUpdating -> ConnectionState.UPDATING
                    is TdApi.ConnectionStateWaitingForNetwork -> ConnectionState.WAITING_NETWORK
                    else -> ConnectionState.DISCONNECTED
                }
            }
        }
    }
    
    private fun handleAuthorizationState(state: TdApi.AuthorizationState) {
        when (state) {
            is TdApi.AuthorizationStateWaitPhoneNumber -> {
                _authState.value = AuthState.WAIT_PHONE
            }
            is TdApi.AuthorizationStateWaitCode -> {
                _authState.value = AuthState.WAIT_CODE(state.codeType, state.timeout)
            }
            is TdApi.AuthorizationStateWaitPassword -> {
                _authState.value = AuthState.WAIT_PASSWORD
            }
            is TdApi.AuthorizationStateReady -> {
                isAuthorized = true
                _authState.value = AuthState.AUTHORIZED
                Log.d(TAG, "Authorization completed successfully")
            }
            is TdApi.AuthorizationStateClosing -> {
                _authState.value = AuthState.CLOSING
            }
            is TdApi.AuthorizationStateClosed -> {
                _authState.value = AuthState.CLOSED
                isAuthorized = false
            }
            else -> {
                _authState.value = AuthState.UNKNOWN
            }
        }
    }
    
    /**
     * Отправить номер телефона для авторизации
     */
    fun sendPhoneNumber(phoneNumber: String) {
        if (!isClientReady()) return
        
        client?.execute(
            TdApi.SetAuthenticationPhoneNumber(phoneNumber, null),
            object : TdClient.ClientResultHandler {
                override fun onResult(result: TdApi.BaseObject?, error: TdApi.Error?) {
                    if (error != null) {
                        Log.e(TAG, "Error sending phone number: ${error.message}")
                        _authState.value = AuthState.ERROR(error.message)
                    }
                }
            }
        )
    }
    
    /**
     * Проверить код подтверждения
     */
    fun checkAuthenticationCode(code: String) {
        if (!isClientReady()) return
        
        client?.execute(
            TdApi.CheckAuthenticationCode(code),
            object : TdClient.ClientResultHandler {
                override fun onResult(result: TdApi.BaseObject?, error: TdApi.Error?) {
                    if (error != null) {
                        Log.e(TAG, "Error checking code: ${error.message}")
                        _authState.value = AuthState.ERROR(error.message)
                    }
                }
            }
        )
    }
    
    /**
     * Проверить пароль облачной аутентификации (2FA)
     */
    fun checkAuthenticationPassword(password: String) {
        if (!isClientReady()) return
        
        client?.execute(
            TdApi.CheckAuthenticationPassword(password),
            object : TdClient.ClientResultHandler {
                override fun onResult(result: TdApi.BaseObject?, error: TdApi.Error?) {
                    if (error != null) {
                        Log.e(TAG, "Error checking password: ${error.message}")
                        _authState.value = AuthState.ERROR(error.message)
                    }
                }
            }
        )
    }
    
    /**
     * Получить историю сообщений из чата за период
     * @param chatId ID чата
     * @param fromDate Начальная дата (Unix timestamp)
     * @param toDate Конечная дата (Unix timestamp)
     * @param limit Максимальное количество сообщений
     */
    suspend fun getChatMessages(
        chatId: Long,
        fromDate: Long,
        toDate: Long = System.currentTimeMillis() / 1000,
        limit: Int = 1000
    ): List<CachedMessage> = withContext(Dispatchers.IO) {
        val messages = mutableListOf<CachedMessage>()
        
        if (!isClientReady() || !isAuthorized) {
            Log.e(TAG, "Client not ready or not authorized")
            return@withContext messages
        }
        
        try {
            // Получаем сообщения через TDLib
            val request = TdApi.GetChatHistory(chatId, limit, 0, 0, 0, 0)
            
            // TDLib работает асинхронно, поэтому используем callback
            val completer = CompletableDeferred<TdApi.Messages?>()
            
            client?.execute(request, object : TdClient.ClientResultHandler {
                override fun onResult(result: TdApi.BaseObject?, error: TdApi.Error?) {
                    if (error != null) {
                        completer.completeExceptionally(Exception(error.message))
                    } else {
                        completer.complete(result as? TdApi.Messages)
                    }
                }
            })
            
            val tdMessages = completer.await()
            
            tdMessages?.messages?.forEach { tdMessage ->
                val cachedMessage = convertToCachedMessage(tdMessage, chatId)
                if (cachedMessage != null && 
                    cachedMessage.date >= fromDate && 
                    cachedMessage.date <= toDate) {
                    messages.add(cachedMessage)
                }
            }
            
            Log.d(TAG, "Retrieved ${messages.size} messages from chat $chatId")
        } catch (e: Exception) {
            Log.e(TAG, "Error getting chat history", e)
        }
        
        messages.sortedBy { it.date }
    }
    
    /**
     * Получить информацию о топиках в форумном чате
     */
    suspend fun getChatTopics(chatId: Long): List<TopicInfo> = withContext(Dispatchers.IO) {
        val topics = mutableListOf<TopicInfo>()
        
        if (!isClientReady() || !isAuthorized) {
            return@withContext topics
        }
        
        try {
            // Запрашиваем информацию о чате
            val request = TdApi.GetChat(chatId)
            val completer = CompletableDeferred<TdApi.Chat?>()
            
            client?.execute(request, object : TdClient.ClientResultHandler {
                override fun onResult(result: TdApi.BaseObject?, error: TdApi.Error?) {
                    if (error != null) {
                        completer.completeExceptionally(Exception(error.message))
                    } else {
                        completer.complete(result as? TdApi.Chat)
                    }
                }
            })
            
            val chat = completer.await()
            
            // Для форумных чатов получаем список топиков
            if (chat?.chatType is TdApi.ChatTypeSupergroup) {
                val supergroup = (chat.chatType as TdApi.ChatTypeSupergroup).supergroupId
                // TDLib не предоставляет прямой API для получения списка топиков
                // Топики определяются через message_thread_id сообщений
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error getting chat topics", e)
        }
        
        topics
    }
    
    private fun convertToCachedMessage(tdMessage: TdApi.Message, chatId: Long): CachedMessage? {
        return try {
            val textContent = when (val content = tdMessage.content) {
                is TdApi.MessageText -> content.text?.text ?: ""
                else -> ""
            }
            
            if (textContent.isBlank() && tdMessage.content !is TdApi.MessageText) {
                return null
            }
            
            val senderId = tdMessage.senderId?.userId ?: 0L
            val senderName = tdMessage.senderId?.let { getSenderName(it) }
            
            CachedMessage(
                id = tdMessage.id,
                chatId = chatId,
                senderId = senderId,
                senderName = senderName,
                text = textContent,
                date = tdMessage.date.toLong(),
                messageThreadId = tdMessage.messageThreadId ?: 0,
                replyToMessageId = tdMessage.replyTo?.messageId,
                hasMedia = tdMessage.content !is TdApi.MessageText,
                isSystemMessage = false // Определяется позже через TextCleaner
            )
        } catch (e: Exception) {
            Log.e(TAG, "Error converting message", e)
            null
        }
    }
    
    private fun getSenderName(senderId: TdApi.MessageSenderId): String? {
        return when (senderId) {
            is TdApi.MessageSenderIdUser -> {
                // Можно запросить информацию о пользователе
                "User${senderId.userId}"
            }
            is TdApi.MessageSenderIdChat -> {
                "Chat${senderId.chatId}"
            }
            else -> null
        }
    }
    
    private fun cacheMessage(tdMessage: TdApi.Message) {
        // Кэширование сообщений в БД будет реализовано в Repository
        // Здесь только логирование
        Log.d(TAG, "New message received: ${tdMessage.id}")
    }
    
    private fun isClientReady(): Boolean {
        return client != null && authorizationState is TdApi.AuthorizationStateReady
    }
    
    /**
     * Закрыть клиент и освободить ресурсы
     */
    fun close() {
        client?.execute(TdApi.Close())
        client = null
        isAuthorized = false
        Log.d(TAG, "TDLib client closed")
    }
    
    companion object {
        private const val TAG = "TdLibManager"
        
        @Volatile
        private var instance: TdLibManager? = null
        
        fun getInstance(context: Context): TdLibManager {
            return instance ?: synchronized(this) {
                instance ?: TdLibManager(context.applicationContext).also {
                    instance = it
                }
            }
        }
    }
}

/**
 * Состояния подключения
 */
enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    UPDATING,
    WAITING_NETWORK,
    ERROR
}

/**
 * Состояния авторизации
 */
sealed class AuthState {
    object INITIAL : AuthState()
    object WAIT_PHONE : AuthState()
    data class WAIT_CODE(val codeType: TdApi.AuthenticationCodeType?, val timeout: Int) : AuthState()
    object WAIT_PASSWORD : AuthState()
    object AUTHORIZED : AuthState()
    object CLOSING : AuthState()
    object CLOSED : AuthState()
    data class ERROR(val message: String) : AuthState()
    object UNKNOWN : AuthState()
}

/**
 * Простой счетчик для ID клиентов
 */
private class AtomicInteger(initialValue: Int = 0) {
    @Volatile private var value = initialValue
    
    fun incrementAndGet(): Int {
        value++
        return value
    }
}
