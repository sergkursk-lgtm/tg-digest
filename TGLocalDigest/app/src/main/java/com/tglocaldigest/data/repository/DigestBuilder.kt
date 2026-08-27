package com.tglocaldigest.data.repository

import com.tglocaldigest.data.model.CachedMessage
import com.tglocaldigest.utils.TextCleaner
import com.tglocaldigest.utils.TopicsMapper

data class DigestTopicData(
    val topicName: String,
    val messageCount: Int,
    val problemCount: Int,
    val solutionCount: Int,
    val cleanedText: String,
    val chunks: List<String>? = null
)

class DigestBuilder {

    private val problemKeywords = listOf(
        "проблема", "сломал", "не работает", "ошибка", "косяк", "брак", "запотев",
        "свист", "вибрация", "скрип", "щелкает", "не видит", "гудит", "стучит",
        "не едет", "не включ", "перегрев", "течёт", "заклинило"
    )

    private val solutionKeywords = listOf(
        "решил", "решили", "помогло", "помог", "сделал", "сделали", "итог",
        "готово", "работает", "получилось", "установил", "норм", "заменил", "поменял"
    )

    private val MAX_CHUNK_SIZE_CHARS = 14000

    fun buildDigestInput(messages: List<CachedMessage>): Map<String, DigestTopicData> {
        if (messages.isEmpty()) return emptyMap()

        val groupedByThread = messages.groupBy { it.messageThreadId }
        val result = mutableMapOf<String, DigestTopicData>()

        groupedByThread.forEach { (threadId, threadMessages) ->
            val topicName = TopicsMapper.getTopicTitle(threadId)
            val processedMessages = processMessages(threadMessages)

            if (processedMessages.isEmpty()) return@forEach

            val allText = processedMessages.joinToString("\n")
            val problemCount = countMatches(allText, problemKeywords)
            val solutionCount = countMatches(allText, solutionKeywords)

            val chunks = if (allText.length > MAX_CHUNK_SIZE_CHARS) {
                splitIntoChunks(allText, MAX_CHUNK_SIZE_CHARS)
            } else {
                null
            }

            result[topicName] = DigestTopicData(
                topicName = topicName,
                messageCount = processedMessages.size,
                problemCount = problemCount,
                solutionCount = solutionCount,
                cleanedText = allText,
                chunks = chunks
            )
        }

        return result
    }

    private fun processMessages(messages: List<CachedMessage>): List<String> {
        return messages
            .mapNotNull { msg ->
                TextCleaner.cleanMessageText(msg.text, msg.isSystemMessage)
            }
            .filter { text ->
                text.isNotEmpty() && !TextCleaner.isSystemMessage(text)
            }
            .map { text ->
                if (text.length > 500) text.take(500) else text
            }
    }

    private fun countMatches(text: String, keywords: List<String>): Int {
        val lowerText = text.lowercase()
        var count = 0
        keywords.forEach { keyword ->
            var index = lowerText.indexOf(keyword)
            while (index != -1) {
                count++
                index = lowerText.indexOf(keyword, index + 1)
            }
        }
        return count
    }

    private fun splitIntoChunks(text: String, maxSize: Int): List<String> {
        val chunks = mutableListOf<String>()
        var currentIndex = 0
        val length = text.length

        while (currentIndex < length) {
            var endIndex = minOf(currentIndex + maxSize, length)

            if (endIndex < length) {
                val lastNewLine = text.lastIndexOf('\n', endIndex)
                if (lastNewLine > currentIndex + maxSize / 2) {
                    endIndex = lastNewLine + 1
                } else {
                    val lastDot = text.lastIndexOf('.', endIndex)
                    if (lastDot > currentIndex + maxSize / 2) {
                        endIndex = lastDot + 1
                    }
                }
            }

            chunks.add(text.substring(currentIndex, endIndex).trim())
            currentIndex = endIndex
        }

        return chunks.filter { it.isNotBlank() }
    }
}
