package com.tglocaldigest.data.repository

import android.content.Context
import android.util.Log
import com.tglocaldigest.data.database.AppDatabase
import com.tglocaldigest.data.model.*
import com.tglocaldigest.data.network.TdLibManager
import com.tglocaldigest.utils.TextCleaner
import com.tglocaldigest.utils.TopicsMapper
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Репозиторий для работы с сообщениями и генерации сводок
 * Объединяет данные из TDLib, локальной БД и LLM
 */
class MessagesRepository private constructor(
    private val context: Context,
    private val database: AppDatabase,
    private val tdLibManager: TdLibManager
) {
    
    private val messageDao = database.messageDao()
    private val topicDao = database.topicDao()
    private val settingsDao = database.settingsDao()
    
    private val mutex = Mutex()
    
    /**
     * Получить сообщения из чата за период
     * Сначала проверяем кэш в БД, если данных недостаточно - запрашиваем через TDLib
     */
    suspend fun getMessagesForPeriod(
        chatId: Long,
        hours: Int = 24
    ): List<CachedMessage> = mutex.withLock {
        val fromDate = (System.currentTimeMillis() / 1000) - (hours * 3600)
        
        // Пробуем получить из кэша
        var cachedMessages = messageDao.getMessagesByDateRange(chatId, fromDate)
        
        // Если кэш пуст или данных мало, запрашиваем через TDLib
        if (cachedMessages.isEmpty() || cachedMessages.size < 10) {
            Log.d(TAG, "Cache miss or insufficient data, fetching from TDLib")
            val freshMessages = tdLibManager.getChatMessages(chatId, fromDate)
            
            if (freshMessages.isNotEmpty()) {
                // Сохраняем в кэш
                messageDao.insertMessages(freshMessages)
                cachedMessages = freshMessages
            }
        }
        
        Log.d(TAG, "Retrieved ${cachedMessages.size} messages for last $hours hours")
        cachedMessages
    }
    
    /**
     * Сгруппировать сообщения по топикам (message_thread_id)
     */
    suspend fun groupMessagesByTopic(messages: List<CachedMessage>): List<GroupedMessages> {
        val grouped = messages.groupBy { it.messageThreadId }
        
        return grouped.map { (threadId, msgs) ->
            val topicName = TopicsMapper.getTopicName(threadId)
            GroupedMessages(
                topicId = threadId,
                topicName = topicName,
                messages = msgs.filter { message ->
                    // Фильтруем сообщения
                    val cleanedText = TextCleaner.cleanMessageText(
                        text = message.text,
                        isSystemMessage = message.isSystemMessage || 
                            TextCleaner.isSystemMessage(message.text)
                    )
                    cleanedText != null
                }.map { message ->
                    // Очищаем текст сообщения
                    val cleanedText = TextCleaner.cleanMessageText(
                        text = message.text,
                        isSystemMessage = false,
                        maxLength = 500
                    )
                    message.copy(text = cleanedText ?: message.text)
                }
            )
        }.filter { it.messages.isNotEmpty() }
    }
    
    /**
     * Подготовить текст для отправки в LLM
     * Объединяет сообщения топика в единый текст с форматированием
     */
    fun prepareContextForLLM(groupedMessages: GroupedMessages): String {
        val sb = StringBuilder()
        
        sb.append("# Топик: ${groupedMessages.topicName}\n\n")
        sb.append("Сообщений: ${groupedMessages.messages.size}\n\n")
        sb.append("---\n\n")
        
        groupedMessages.messages.forEach { message ->
            // Форматируем каждое сообщение
            sb.append("[${formatTimestamp(message.date)}]: ${message.text}\n")
            sb.append("\n")
        }
        
        sb.append("---\n")
        
        return sb.toString()
    }
    
    /**
     * Разбить контекст на части если он превышает лимит токенов
     */
    fun splitContextIfNeeded(context: String, maxTokens: Int = 4000): List<String> {
        return TextCleaner.splitByTokenLimit(context, maxTokens)
    }
    
    /**
     * Сохранить результат сводки в БД
     */
    suspend fun saveDigestResult(result: DigestResult) {
        // В реальной реализации можно создать отдельную таблицу для сводок
        // Пока просто логируем
        Log.d(TAG, "Saved digest for topic ${result.topicName}: ${result.summaryMarkdown.length} chars")
    }
    
    /**
     * Получить последнюю дату генерации сводки
     */
    suspend fun getLastDigestTime(): Long {
        return settingsDao.getValueByKey(UserSettings.KEY_LAST_DIGEST_TIME)?.toLongOrNull() ?: 0L
    }
    
    /**
     * Обновить время последней генерации сводки
     */
    suspend fun updateLastDigestTime(timestamp: Long) {
        settingsDao.insertSetting(
            UserSettings(UserSettings.KEY_LAST_DIGEST_TIME, timestamp.toString())
        )
    }
    
    /**
     * Сохранить настройки чата
     */
    suspend fun saveChatId(chatId: Long) {
        settingsDao.insertSetting(
            UserSettings(UserSettings.KEY_CHAT_ID, chatId.toString())
        )
    }
    
    /**
     * Получить сохраненный Chat ID
     */
    suspend fun getSavedChatId(): Long? {
        return settingsDao.getValueByKey(UserSettings.KEY_CHAT_ID)?.toLongOrNull()
    }
    
    /**
     * Очистить старые сообщения из кэша
     */
    suspend fun cleanupOldMessages(chatId: Long, daysToKeep: Int = 7) {
        val beforeDate = (System.currentTimeMillis() / 1000) - (daysToKeep * 86400)
        messageDao.deleteOldMessages(chatId, beforeDate)
        Log.d(TAG, "Cleaned up old messages before $beforeDate")
    }
    
    private fun formatTimestamp(unixTime: Long): String {
        val format = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
        return format.format(java.util.Date(unixTime * 1000))
    }
    
    companion object {
        private const val TAG = "MessagesRepository"
        
        @Volatile
        private var instance: MessagesRepository? = null
        
        fun getInstance(
            context: Context,
            database: AppDatabase,
            tdLibManager: TdLibManager
        ): MessagesRepository {
            return instance ?: synchronized(this) {
                instance ?: MessagesRepository(
                    context.applicationContext,
                    database,
                    tdLibManager
                ).also { instance = it }
            }
        }
    }
}
