package com.tglocaldigest.data.database

import androidx.room.*
import com.tglocaldigest.data.model.*
import kotlinx.coroutines.flow.Flow

@Dao
interface MessageDao {
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertMessage(message: CachedMessage)
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertMessages(messages: List<CachedMessage>)
    
    @Query("SELECT * FROM messages WHERE chatId = :chatId AND date >= :fromDate ORDER BY date ASC")
    suspend fun getMessagesByDateRange(chatId: Long, fromDate: Long): List<CachedMessage>
    
    @Query("SELECT * FROM messages WHERE chatId = :chatId AND messageThreadId = :threadId ORDER BY date ASC")
    suspend fun getMessagesByThread(chatId: Long, threadId: Int): List<CachedMessage>
    
    @Query("DELETE FROM messages WHERE chatId = :chatId AND date < :beforeDate")
    suspend fun deleteOldMessages(chatId: Long, beforeDate: Long)
    
    @Query("SELECT DISTINCT messageThreadId FROM messages WHERE chatId = :chatId")
    suspend fun getAllThreadIds(chatId: Long): List<Int>
}

@Dao
interface TopicDao {
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTopic(topic: TopicInfo)
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTopics(topics: List<TopicInfo>)
    
    @Query("SELECT * FROM topics WHERE messageThreadId = :threadId")
    suspend fun getTopicById(threadId: Int): TopicInfo?
    
    @Query("SELECT * FROM topics")
    fun getAllTopics(): Flow<List<TopicInfo>>
}

@Dao
interface SettingsDao {
    
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSetting(setting: UserSettings)
    
    @Query("SELECT * FROM settings WHERE key = :key")
    suspend fun getSettingByKey(key: String): UserSettings?
    
    @Query("SELECT value FROM settings WHERE key = :key")
    suspend fun getValueByKey(key: String): String?
}

@Database(
    entities = [CachedMessage::class, TopicInfo::class, UserSettings::class],
    version = 1,
    exportSchema = false
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun messageDao(): MessageDao
    abstract fun topicDao(): TopicDao
    abstract fun settingsDao(): SettingsDao
    
    companion object {
        const val DATABASE_NAME = "tg_local_digest_db"
    }
}
