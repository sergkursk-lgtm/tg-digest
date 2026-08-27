package com.tglocaldigest.llama

import android.content.Context
import android.util.Log
import com.tglocaldigest.data.repository.DigestTopicData
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

class DigestGenerator(private val llamaManager: LlamaManager) {

    private val SYSTEM_PROMPT = """Ты — безэмоциональный аналитик-суммаризатор для автомобильного клуба. Твоя ЕДИНСТВЕННАЯ задача — делать сводку переписок. На любые другие вопросы отвечай: 'Я делаю только сводки'.
ПРАВИЛА:
1. Никогда не копируй сообщения дословно. Пересказывай суть своими словами.
2. Игнорируй 'воду', приветствия, оффтоп и эмоции. Выделяй только факты, проблемы, решения и советы.
3. СТРОГО ЗАПРЕЩЕНО указывать имена, никнеймы или ID отправителей. Только содержание.
4. Отмечай статус обсуждения: решено ✓ / не решено / требует уточнения.
5. Не выдумывай фактов. Если в тексте нет решения проблемы, так и пиши 'не решено'.

СТРОГИЙ ФОРМАТ ВЫВОДА (используй этот Markdown, ничего не меняй):
# [Название топика] — Сводка
> [Количество] сообщений · [Количество] проблем · [Количество] решений

📌 ГЛАВНОЕ
- [2-4 буллита с самой сутью: что случилось, какие критические проблемы]

🔥 ОБСУЖДЕНИЕ
- [Тема 1] — [краткая суть]
- [Тема 2] — [краткая суть]

❓ БЕЗ ОТВЕТА
- [Вопрос 1]
- [Вопрос 2]

✅ РЕШЕНИЯ
- [Суть найденного решения. Если нет — пиши 'Нет решений за этот период.']

Статус: [решено ✓ / не решено / требует уточнения]"""

    suspend fun generateFullDigest(topicsData: Map<String, DigestTopicData>): String {
        val results = mutableListOf<String>()
        
        val header = "# TG Local Digest\n\n📅 Отчет сгенерирован локально на устройстве.\n\n---\n\n"
        results.add(header)

        topicsData.forEach { (topicName, data) ->
            try {
                val summary = processTopic(data)
                results.add(summary)
                results.add("---\n\n")
            } catch (e: Exception) {
                Log.e("DigestGenerator", "Error processing topic $topicName", e)
                results.add("## Ошибка обработки топика: $topicName\n${e.message}\n\n---\n\n")
            }
        }

        return results.joinToString("")
    }

    private suspend fun processTopic(data: DigestTopicData): String {
        return if (data.chunks != null && data.chunks.size > 1) {
            processWithChunks(data)
        } else {
            processSingleChunk(data.cleanedText, data.topicName, data.messageCount, data.problemCount, data.solutionCount)
        }
    }

    private suspend fun processWithChunks(data: DigestTopicData): String {
        val chunkSummaries = mutableListOf<String>()

        data.chunks.forEachIndexed { index, chunkText ->
            val chunkPrompt = "Часть $index/${data.chunks.size} переписки по теме '${data.topicName}'.\n\n$chunkText"
            
            val tempSummary = generateWithPrompt(
                "Сделай краткую выжимку фактов из этой части переписки. Только факты, без форматирования.",
                chunkPrompt
            )
            
            if (tempSummary != null) {
                chunkSummaries.add(tempSummary)
            }
        }

        val combinedSummary = chunkSummaries.joinToString("\n\n--- ПРОМЕЖУТОК ---\n\n")
        
        val finalUserPrompt = "На основе следующих промежуточных суммарий сделай ФИНАЛЬНЫЙ отчет строго по формату.\n" +
                              "Статистика: Сообщений=${data.messageCount}, Проблем=${data.problemCount}, Решений=${data.solutionCount}\n\n" +
                              combinedSummary
        
        return processSingleChunk(finalUserPrompt, data.topicName, data.messageCount, data.problemCount, data.solutionCount, true)
    }

    private suspend fun processSingleChunk(
        text: String, 
        topicName: String, 
        msgCount: Int, 
        probCount: Int, 
        solCount: Int,
        isFinalStep: Boolean = false
    ): String {
        
        val userPrompt = if (isFinalStep) {
            text
        } else {
            "Контекст переписки:\n$text"
        }

        val resultText = generateWithPrompt(SYSTEM_PROMPT, userPrompt)
        
        return resultText ?: "## Ошибка генерации для топика: $topicName\nНе удалось получить ответ от модели."
    }

    private suspend fun generateWithPrompt(system: String, user: String): String? {
        return suspendCancellableCoroutine { continuation ->
            llamaManager.generate(system, user) { result ->
                if (continuation.isActive) {
                    if (result.isSuccess) {
                        continuation.resume(result.getOrNull())
                    } else {
                        continuation.resume(null)
                    }
                }
            }
        }
    }
}
