package com.tglocaldigest.llama

import android.content.Context
import android.util.Log
import com.tglocaldigest.data.model.DigestResult
import com.tglocaldigest.data.model.GroupedMessages
import com.tglocaldigest.utils.FileUtils
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Менеджер для работы с локальной LLM (Qwen2.5-1.5B-Instruct)
 * Обертка над JNI биндингами для llama.cpp
 */
class LlamaManager private constructor(private val context: Context) {
    
    init {
        System.loadLibrary("tglocaldigest-llama")
        Log.d(TAG, "LlamaManager native library loaded")
    }
    
    // Native methods
    private external fun loadModel(modelPath: String): Boolean
    private external fun unloadModel()
    private external fun generate(systemPrompt: String, userPrompt: String): String
    private external fun setGenerationParams(
        threads: Int,
        contextSize: Int,
        batchSize: Int,
        maxTokens: Int,
        temperature: Float
    )
    private external fun isModelLoaded(): Boolean
    private external fun getModelInfo(): String
    
    private var isInitialized = false
    
    /**
     * Инициализировать LLM менеджер и загрузить модель
     */
    suspend fun initialize(modelAssetPath: String = "qwen2.5-1.5b-instruct-q4_k_m.gguf"): Boolean = 
        withContext(Dispatchers.IO) {
            if (isInitialized) {
                Log.d(TAG, "Already initialized")
                return@withContext true
            }
            
            try {
                // Копируем модель из assets если нужно
                val modelFile = FileUtils.getModelDirectory(context).let { dir ->
                    java.io.File(dir, "model.gguf")
                }
                
                if (!modelFile.exists()) {
                    Log.d(TAG, "Copying model from assets: $modelAssetPath")
                    try {
                        context.assets.open(modelAssetPath).use { input ->
                            modelFile.outputStream().use { output ->
                                input.copyTo(output)
                            }
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Model not found in assets, using file path directly", e)
                        // Модель должна быть скачана пользователем отдельно
                        return@withContext false
                    }
                }
                
                // Настраиваем параметры генерации
                setGenerationParams(
                    threads = 4, // Оптимизировано для мобильных CPU
                    contextSize = 4096,
                    batchSize = 512,
                    maxTokens = 512,
                    temperature = 0.7f
                )
                
                // Загружаем модель
                val success = loadModel(modelFile.absolutePath)
                
                if (success) {
                    isInitialized = true
                    Log.d(TAG, "LLM initialized successfully: ${getModelInfo()}")
                } else {
                    Log.w(TAG, "Failed to load model - using stub mode")
                }
                
                success
            } catch (e: Exception) {
                Log.e(TAG, "Error initializing LLM", e)
                false
            }
        }
    
    /**
     * Сгенерировать сводку для одного топика
     * @param groupedMessages Сгруппированные сообщения топика
     * @return Markdown текст сводки
     */
    suspend fun generateDigest(groupedMessages: GroupedMessages): DigestResult = 
        withContext(Dispatchers.IO) {
            val contextText = prepareContext(groupedMessages)
            
            val systemPrompt = SYSTEM_PROMPT.replace("{topicName}", groupedMessages.topicName)
            
            Log.d(TAG, "Generating digest for topic: ${groupedMessages.topicName}")
            Log.d(TAG, "Context length: ${contextText.length} chars")
            
            val response = if (isModelLoaded()) {
                generate(systemPrompt, contextText)
            } else {
                generateStubResponse(groupedMessages)
            }
            
            DigestResult(
                topicId = groupedMessages.topicId,
                topicName = groupedMessages.topicName,
                summaryMarkdown = response,
                messageCount = groupedMessages.messages.size,
                generatedAt = System.currentTimeMillis()
            )
        }
    
    /**
     * Сгенерировать сводки для всех топиков
     */
    suspend fun generateDigestsForTopics(
        groupedMessagesList: List<GroupedMessages>
    ): List<DigestResult> = withContext(Dispatchers.IO) {
        val results = mutableListOf<DigestResult>()
        
        for ((index, grouped) in groupedMessagesList.withIndex()) {
            Log.d(TAG, "Processing topic ${index + 1}/${groupedMessagesList.size}: ${grouped.topicName}")
            
            try {
                val result = generateDigest(grouped)
                results.add(result)
            } catch (e: Exception) {
                Log.e(TAG, "Error generating digest for ${grouped.topicName}", e)
                // Продолжаем обработку остальных топиков
            }
        }
        
        results
    }
    
    /**
     * Подготовить контекст для отправки в LLM
     */
    private fun prepareContext(groupedMessages: GroupedMessages): String {
        val sb = StringBuilder()
        
        sb.append("# Топик: ${groupedMessages.topicName}\n\n")
        sb.append("Количество сообщений: ${groupedMessages.messages.size}\n\n")
        sb.append("=== Сообщения ===\n\n")
        
        groupedMessages.messages.forEachIndexed { index, message ->
            sb.append("${index + 1}. [${formatTime(message.date)}] ${message.text}\n")
        }
        
        sb.append("\n=== Конец сообщений ===\n")
        
        return sb.toString()
    }
    
    /**
     * Создать stub ответ если модель не загружена (для тестирования)
     */
    private fun generateStubResponse(groupedMessages: GroupedMessages): String {
        return """
# ${groupedMessages.topicName} — Сводка
> ${groupedMessages.messages.size} сообщений

📌 ГЛАВНОЕ
- Stub режим: модель Qwen2.5-1.5B не загружена
- Для полноценной работы скачайте модель в формате GGUF

🔥 ОБСУЖДЕНИЕ
- Получено ${groupedMessages.messages.size} сообщений за период
- Требуется загрузка модели для анализа

❓ БЕЗ ОТВЕТА
- Модель не инициализирована

✅ РЕШЕНИЯ
- Скачайте qwen2.5-1.5b-instruct-q4_k_m.gguf и поместите в assets/

Статус: не решено
""".trimIndent()
    }
    
    private fun formatTime(unixTime: Long): String {
        val format = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault())
        return format.format(java.util.Date(unixTime * 1000))
    }
    
    /**
     * Освободить ресурсы
     */
    fun release() {
        if (isInitialized) {
            unloadModel()
            isInitialized = false
            Log.d(TAG, "LLM resources released")
        }
    }
    
    companion object {
        private const val TAG = "LlamaManager"
        
        /**
         * СИСТЕМНЫЙ ПРОМПТ - ЖЕСТКО ЗАШИТ В КОД
         * Передается в LLM как system_prompt при каждом запросе
         */
        private const val SYSTEM_PROMPT = """Ты — безэмоциональный аналитик-суммаризатор для автомобильного клуба. Твоя ЕДИНСТВЕННАЯ задача — делать сводку переписок. На любые другие вопросы отвечай: 'Я делаю только сводки'.
ПРАВИЛА:
1. Никогда не копируй сообщения дословно. Пересказывай суть своими словами.
2. Игнорируй 'воду', приветствия, оффтоп и эмоции. Выделяй только факты, проблемы, решения и советы.
3. СТРОГО ЗАПРЕЩЕНО указывать имена, никнеймы или ID отправителей. Только содержание.
4. Отмечай статус обсуждения: решено ✓ / не решено / требует уточнения.
5. Не выдумывай фактов. Если в тексте нет решения проблемы, так и пиши 'не решено'.

СТРОГИЙ ФОРМАТ ВЫВОДА (используй этот Markdown, ничего не меняй):
# {topicName} — Сводка
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
        
        @Volatile
        private var instance: LlamaManager? = null
        
        fun getInstance(context: Context): LlamaManager {
            return instance ?: synchronized(this) {
                instance ?: LlamaManager(context.applicationContext).also {
                    instance = it
                }
            }
        }
    }
}
