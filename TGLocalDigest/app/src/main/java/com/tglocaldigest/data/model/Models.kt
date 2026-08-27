package com.tglocaldigest.data.model

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Сообщение Telegram из локального кэша
 */
@Entity(tableName = "messages")
data class CachedMessage(
    @PrimaryKey val id: Long,
    val chatId: Long,
    val senderId: Long,
    val senderName: String?,
    val text: String,
    val date: Long, // Unix timestamp
    val messageThreadId: Int = 0, // ID топика для форумных чатов
    val replyToMessageId: Long? = null,
    val hasMedia: Boolean = false,
    val isSystemMessage: Boolean = false
)

/**
 * Топик форумного чата
 */
@Entity(tableName = "topics")
data class TopicInfo(
    @PrimaryKey val messageThreadId: Int,
    val name: String,
    val lastUpdated: Long
)

/**
 * Сгруппированные сообщения по топику
 */
data class GroupedMessages(
    val topicId: Int,
    val topicName: String,
    val messages: List<CachedMessage>
)

/**
 * Результат генерации сводки
 */
data class DigestResult(
    val topicId: Int,
    val topicName: String,
    val summaryMarkdown: String,
    val messageCount: Int,
    val generatedAt: Long = System.currentTimeMillis()
)

/**
 * Настройки пользователя
 */
@Entity(tableName = "settings")
data class UserSettings(
    @PrimaryKey val key: String,
    val value: String
) {
    companion object {
        const val KEY_PHONE = "phone"
        const val KEY_CHAT_ID = "chat_id"
        const val KEY_LAST_DIGEST_TIME = "last_digest_time"
    }
}
