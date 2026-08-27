package com.tglocaldigest.utils

import java.util.regex.Pattern

/**
 * Утилиты для очистки и предобработки текста сообщений
 */
object TextCleaner {
    
    // Паттерн для удаления эмодзи (Unicode ranges)
    // ВАЖНО: НЕ включаем \u0400-\u04FF (кириллица), иначе удалится весь русский текст!
    private val emojiPattern = Pattern.compile(
        "[" +
            "\u0600-\u06FF" +  // Arabic
            "\u2190-\u21FF" +  // Arrows
            "\u2300-\u23FF" +  // Misc Technical
            "\u2460-\u24FF" +  // Enclosed alphanumerics
            "\u25A0-\u25FF" +  // Geometric Shapes
            "\u2600-\u26FF" +  // Misc Symbols
            "\u2700-\u27BF" +  // Dingbats
            "\u2E80-\u2EFF" +  // CJK Radicals
            "\u3000-\u30FF" +  // CJK Symbols
            "\u31F0-\u31FF" +  // Katakana Phonetic Extensions
            "\uFE00-\uFE0F" +  // Variation Selectors
            "\uFE30-\uFE4F" +  // CJK Compatibility Forms
            "\uFF00-\uFFEF" +  // Halfwidth and Fullwidth Forms
            "\uD83C[\uDC00-\uDFFF]" +  // Emoji variation selectors
            "\uD83D[\uDC00-\uDFFF]" +
            "\uD83E[\uDC00-\uDFFF]" +
            "]+",
        Pattern.UNICODE_CASE or Pattern.CASE_INSENSITIVE
    )
    
    // Паттерн для удаления URL
    private val urlPattern = Pattern.compile(
        "(https?://)?[a-zA-Z0-9][-a-zA-Z0-9]*\\.[a-zA-Z]{2,}(/[^\\s]*)?",
        Pattern.CASE_INSENSITIVE
    )
    
    /**
     * Очистить текст сообщения перед отправкой в LLM
     * - Удаляет эмодзи (кроме базовых символов)
     * - Удаляет системные сообщения
     * - Обрезает до maxLength символов
     * - Удаляет лишние пробелы и переносы строк
     */
    fun cleanMessageText(
        text: String,
        isSystemMessage: Boolean = false,
        maxLength: Int = 500
    ): String? {
        // Пропускаем системные сообщения
        if (isSystemMessage) return null
        
        if (text.isBlank()) return null
        
        var cleaned = text.trim()
        
        // Удаляем эмодзи
        cleaned = emojiPattern.matcher(cleaned).replaceAll("")
        
        // Удаляем URL (можно оставить по необходимости)
        // cleaned = urlPattern.matcher(cleaned).replaceAll("[URL]")
        
        // Нормализуем пробелы и переносы строк
        cleaned = cleaned
            .replace("\\s+".toRegex(), " ")
            .replace("\n{3,}".toRegex(), "\n\n")
            .trim()
        
        // Обрезаем если слишком длинное
        if (cleaned.length > maxLength) {
            cleaned = cleaned.substring(0, maxLength - 3) + "..."
        }
        
        return cleaned.ifBlank { null }
    }
    
    /**
     * Проверить является ли сообщение системным
     */
    fun isSystemMessage(text: String): Boolean {
        val systemPatterns = listOf(
            "^пользователь.*вошел.*чат",
            "^пользователь.*вышел.*чат",
            "^изменил.*название",
            "^изменил.*описание",
            "^закрепил.*сообщение",
            "^удалил.*сообщение",
            "^пригласил.*участника",
            "^added.*member",
            "^removed.*member",
            "^changed.*title",
            "^pinned.*message"
        )
        
        val lowerText = text.lowercase()
        return systemPatterns.any { pattern ->
            pattern.toRegex().containsMatchIn(lowerText)
        }
    }
    
    /**
     * Подсчитать приблизительное количество токенов в тексте
     * (грубая оценка: 1 токен ≈ 4 символа для русского/английского)
     */
    fun estimateTokenCount(text: String): Int {
        return (text.length / 4.0).toInt()
    }
    
    /**
     * Разбить текст на части если он превышает лимит токенов
     */
    fun splitByTokenLimit(text: String, maxTokens: Int = 4000): List<String> {
        val estimatedTokens = estimateTokenCount(text)
        
        if (estimatedTokens <= maxTokens) {
            return listOf(text)
        }
        
        // Разбиваем по абзацам
        val paragraphs = text.split("\n\n")
        val chunks = mutableListOf<String>()
        var currentChunk = StringBuilder()
        var currentTokens = 0
        
        for (paragraph in paragraphs) {
            val paragraphTokens = estimateTokenCount(paragraph)
            
            if (currentTokens + paragraphTokens > maxTokens) {
                if (currentChunk.isNotEmpty()) {
                    chunks.add(currentChunk.toString())
                    currentChunk = StringBuilder()
                    currentTokens = 0
                }
                
                // Если отдельный параграф слишком большой, разбиваем его
                if (paragraphTokens > maxTokens) {
                    val sentences = paragraph.split(". ")
                    for (sentence in sentences) {
                        val sentenceTokens = estimateTokenCount(sentence)
                        if (currentTokens + sentenceTokens > maxTokens) {
                            chunks.add(currentChunk.toString())
                            currentChunk = StringBuilder()
                            currentTokens = 0
                        }
                        currentChunk.append(sentence).append(". ")
                        currentTokens += sentenceTokens
                    }
                } else {
                    currentChunk.append(paragraph)
                    currentTokens = paragraphTokens
                }
            } else {
                currentChunk.append(paragraph).append("\n\n")
                currentTokens += paragraphTokens
            }
        }
        
        if (currentChunk.isNotEmpty()) {
            chunks.add(currentChunk.toString())
        }
        
        return chunks.filter { it.isNotBlank() }
    }
}
