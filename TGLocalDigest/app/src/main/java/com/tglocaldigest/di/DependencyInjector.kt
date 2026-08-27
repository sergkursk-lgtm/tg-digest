package com.tglocaldigest.di

import android.content.Context
import androidx.room.Room
import com.tglocaldigest.data.database.AppDatabase
import com.tglocaldigest.data.network.TdLibManager
import com.tglocaldigest.data.repository.MessagesRepository
import com.tglocaldigest.llama.LlamaManager
import com.tglocaldigest.ui.screens.DigestViewModel

/**
 * Внедрение зависимостей (простая реализация без DI-фреймворка)
 * Для production рекомендуется использовать Hilt или Koin
 */
object DependencyInjector {
    
    @Volatile
    private var database: AppDatabase? = null
    @Volatile
    private var tdLibManager: TdLibManager? = null
    @Volatile
    private var llamaManager: LlamaManager? = null
    @Volatile
    private var messagesRepository: MessagesRepository? = null
    
    /**
     * Инициализировать все зависимости
     */
    fun initialize(context: Context) {
        getDatabase(context)
        getTdLibManager(context)
        getLlamaManager(context)
        getMessagesRepository(context)
    }
    
    /**
     * Получить экземпляр базы данных
     */
    fun getDatabase(context: Context): AppDatabase {
        return database ?: synchronized(this) {
            database ?: Room.databaseBuilder(
                context.applicationContext,
                AppDatabase::class.java,
                AppDatabase.DATABASE_NAME
            ).build().also { database = it }
        }
    }
    
    /**
     * Получить TDLib менеджер
     */
    fun getTdLibManager(context: Context): TdLibManager {
        return tdLibManager ?: synchronized(this) {
            tdLibManager ?: TdLibManager.getInstance(context).also { tdLibManager = it }
        }
    }
    
    /**
     * Получить LLM менеджер
     */
    fun getLlamaManager(context: Context): LlamaManager {
        return llamaManager ?: synchronized(this) {
            llamaManager ?: LlamaManager.getInstance(context).also { llamaManager = it }
        }
    }
    
    /**
     * Получить репозиторий сообщений
     */
    fun getMessagesRepository(context: Context): MessagesRepository {
        return messagesRepository ?: synchronized(this) {
            messagesRepository ?: MessagesRepository.getInstance(
                context,
                getDatabase(context),
                getTdLibManager(context)
            ).also { messagesRepository = it }
        }
    }
    
    /**
     * Создать ViewModel для экрана сводок
     */
    fun provideDigestViewModel(context: Context): DigestViewModel {
        return DigestViewModel(
            messagesRepository = getMessagesRepository(context),
            llamaManager = getLlamaManager(context)
        )
    }
    
    /**
     * Очистить ресурсы при закрытии приложения
     */
    fun release() {
        llamaManager?.release()
        tdLibManager?.close()
        
        database?.close()
        
        database = null
        tdLibManager = null
        llamaManager = null
        messagesRepository = null
    }
}
