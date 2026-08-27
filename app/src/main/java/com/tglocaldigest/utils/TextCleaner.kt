// utils/TextCleaner.kt
package com.tglocaldigest.utils

import java.util.regex.Pattern

object TextCleaner {
    
    // Исправленный паттерн: удаляем ТОЛЬКО эмодзи и спецсимволы, НЕ трогая кириллицу (\u0400-\u04FF)
    // Используем комбинацию диапазонов Unicode для эмодзи и технических символов
    private val emojiPattern = Pattern.compile(
        "[" +
        "\\u0600-\\u06FF" +      // Arabic
        "\\u2190-\\u21FF" +      // Arrows
        "\\u2300-\\u23FF" +      // Misc Technical
        "\\u2460-\\u24FF" +      // Enclosed alphanumerics
        "\\u25A0-\\u25FF" +      // Geometric Shapes
        "\\u2600-\\u26FF" +      // Misc Symbols
        "\\u2700-\\u27BF" +      // Dingbats
        "\\u2E80-\\u2EFF" +      // CJK Radicals Supplement
        "\\u2F00-\\u2FDF" +      // Kangxi Radicals
        "\\u2FF0-\\u2FFF" +      // Ideographic Description Characters
        "\\u3000-\\u303F" +      // CJK Symbols and Punctuation
        "\\u3040-\\u309F" +      // Hiragana
        "\\u30A0-\\u30FF" +      // Katakana
        "\\u3100-\\u312F" +      // Bopomofo
        "\\u3130-\\u318F" +      // Hangul Compatibility Jamo
        "\\u3190-\\u319F" +      // Kanbun
        "\\u31A0-\\u31BF" +      // Bopomofo Extended
        "\\u31C0-\\u31EF" +      // CJK Strokes
        "\\u31F0-\\u31FF" +      // Katakana Phonetic Extensions
        "\\u3200-\\u32FF" +      // Enclosed CJK Letters and Months
        "\\u3300-\\u33FF" +      // CJK Compatibility
        "\\u3400-\\u4DBF" +      // CJK Unified Ideographs Extension A
        "\\u4DC0-\\u4DFF" +      // Yijing Hexagram Symbols
        "\\u4E00-\\u9FFF" +      // CJK Unified Ideographs
        "\\u9F00-\\u9FFF" +      // Kangxi Radicals (duplicate coverage)
        "\\uA000-\\uA48F" +      // Yi Syllables
        "\\uA490-\\uA4CF" +      // Yi Radicals
        "\\uAC00-\\uD7AF" +      // Hangul Syllables
        "\\uD800-\\uDB7F" +      // High Surrogates (part of surrogate pairs for emojis)
        "\\uDB80-\\uDBFF" +      // High Private Use Surrogates
        "\\uDC00-\\uDFFF" +      // Low Surrogates (part of surrogate pairs for emojis)
        "\\uF900-\\uFAFF" +      // CJK Compatibility Ideographs
        "\\uFB00-\\uFB4F" +      // Alphabetic Presentation Forms
        "\\uFB50-\\uFDFF" +      // Arabic Presentation Forms-A
        "\\uFE20-\\uFE2F" +      // Combining Half Marks
        "\\uFE30-\\uFE4F" +      // CJK Compatibility Forms
        "\\uFE50-\\uFE6F" +      // Small Form Variants
        "\\uFE70-\\uFEFF" +      // Arabic Presentation Forms-B
        "\\uFF00-\\uFFEF" +      // Halfwidth and Fullwidth Forms
        "\\u{1F000}-\\u{1F02F}" + // Mahjong Tiles
        "\\u{1F030}-\\u{1F09F}" + // Domino Tiles
        "\\u{1F0A0}-\\u{1F0FF}" + // Playing Cards
        "\\u{1F100}-\\u{1F1FF}" + // Enclosed Alphanumeric Supplement
        "\\u{1F200}-\\u{1F2FF}" + // Enclosed Ideographic Supplement
        "\\u{1F300}-\\u{1F5FF}" + // Misc Symbols and Pictographs
        "\\u{1F600}-\\u{1F64F}" + // Emoticons
        "\\u{1F650}-\\u{1F67F}" + // Ornamental Dingbats
        "\\u{1F680}-\\u{1F6FF}" + // Transport and Map Symbols
        "\\u{1F700}-\\u{1F77F}" + // Alchemical Symbols
        "\\u{1F780}-\\u{1F7FF}" + // Geometric Shapes Extended
        "\\u{1F800}-\\u{1F8FF}" + // Supplemental Arrows-C
        "\\u{1F900}-\\u{1F9FF}" + // Supplemental Symbols and Pictographs
        "\\u{1FA00}-\\u{1FA6F}" + // Chess Symbols
        "\\u{1FA70}-\\u{1FAFF}" + // Symbols and Pictographs Extended-A
        "\\u{1FB00}-\\u{1FBFF}" + // Symbols for Legacy Computing
        "]+"
    )
    
    fun cleanMessage(text: String): String {
        if (text.length > 500) {
            return text.substring(0, 500)
        }
        return removeEmojis(text)
    }
    
    private fun removeEmojis(text: String): String {
        val matcher = emojiPattern.matcher(text)
        return matcher.replaceAll("")
    }
    
    fun filterSystemMessages(messages: List<String>): List<String> {
        val systemKeywords = listOf(
            "вошёл", "вошла", "покинул", "покинула", 
            "присоединился", "присоединилась", "покинул чат", 
            "изменил название", "изменила название", 
            "добавил", "добавила", "удалил", "удалила"
        )
        
        return messages.filter { message ->
            val lowerMessage = message.lowercase()
            !systemKeywords.any { keyword -> lowerMessage.contains(keyword) }
        }
    }
}
