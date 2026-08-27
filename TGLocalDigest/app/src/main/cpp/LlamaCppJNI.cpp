/**
 * JNI биндинги для llama.cpp
 * Интеграция локальной LLM с Android приложением
 */

#include <jni.h>
#include <string>
#include <vector>
#include <sstream>
#include <android/log.h>

#define LOG_TAG "LlamaCppJNI"
#define LOGD(...) __android_log_print(ANDROID_LOG_DEBUG, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// Включаем заголовки llama.cpp если они доступны
#ifdef LLAMA_CPP_AVAILABLE
#include "llama.h"
#endif

// Глобальный указатель на контекст модели
static void* g_model = nullptr;
static void* g_context = nullptr;

// Структура для хранения параметров генерации
struct GenerationParams {
    int32_t n_threads = 4;
    int32_t n_ctx = 4096;
    int32_t n_batch = 512;
    int32_t n_predict = 512;
    float temperature = 0.7f;
    int32_t top_k = 40;
    float top_p = 0.9f;
};

static GenerationParams g_params;

extern "C" {

/**
 * Инициализировать LLM модель
 * @param modelPath Путь к файлу модели в формате GGUF
 * @return true если успешно
 */
JNIEXPORT jboolean JNICALL
Java_com_tglocaldigest_llama_LlamaCppModel_loadModel(
    JNIEnv* env,
    jobject thiz,
    jstring modelPath
) {
    LOGD("Loading model from: %s", env->GetStringUTFChars(modelPath, nullptr));
    
#ifdef LLAMA_CPP_AVAILABLE
    const char* model_path = env->GetStringUTFChars(modelPath, nullptr);
    
    // Параметры загрузки модели
    struct llama_model_params model_params = llama_model_default_params();
    model_params.n_gpu_layers = 0; // CPU only для мобильных
    
    // Загружаем модель
    g_model = llama_load_model_from_file(model_path, model_params);
    
    env->ReleaseStringUTFChars(modelPath, model_path);
    
    if (g_model == nullptr) {
        LOGE("Failed to load model");
        return JNI_FALSE;
    }
    
    // Создаем контекст
    struct llama_context_params ctx_params = llama_context_default_params();
    ctx_params.n_ctx = g_params.n_ctx;
    ctx_params.n_batch = g_params.n_batch;
    ctx_params.n_threads = g_params.n_threads;
    
    g_context = llama_new_context_with_model(g_model, ctx_params);
    
    if (g_context == nullptr) {
        LOGE("Failed to create context");
        llama_free_model(g_model);
        g_model = nullptr;
        return JNI_FALSE;
    }
    
    LOGD("Model loaded successfully");
    return JNI_TRUE;
#else
    LOGE("llama.cpp not available - using stub implementation");
    return JNI_FALSE;
#endif
}

/**
 * Освободить ресурсы модели
 */
JNIEXPORT void JNICALL
Java_com_tglocaldigest_llama_LlamaCppModel_unloadModel(JNIEnv* env, jobject thiz) {
#ifdef LLAMA_CPP_AVAILABLE
    if (g_context != nullptr) {
        llama_free(g_context);
        g_context = nullptr;
    }
    if (g_model != nullptr) {
        llama_free_model(g_model);
        g_model = nullptr;
    }
    LOGD("Model unloaded");
#endif
}

/**
 * Сгенерировать ответ от LLM
 * @param systemPrompt Системный промпт
 * @param userPrompt Пользовательский запрос
 * @return Сгенерированный текст
 */
JNIEXPORT jstring JNICALL
Java_com_tglocaldigest_llama_LlamaCppModel_generate(
    JNIEnv* env,
    jobject thiz,
    jstring systemPrompt,
    jstring userPrompt
) {
    const char* system_prompt = env->GetStringUTFChars(systemPrompt, nullptr);
    const char* user_prompt = env->GetStringUTFChars(userPrompt, nullptr);
    
    LOGD("Generating response with system prompt: %.50s...", system_prompt);
    LOGD("User prompt length: %zu chars", strlen(user_prompt));
    
#ifdef LLAMA_CPP_AVAILABLE
    if (g_model == nullptr || g_context == nullptr) {
        LOGE("Model not loaded");
        env->ReleaseStringUTFChars(systemPrompt, system_prompt);
        env->ReleaseStringUTFChars(userPrompt, user_prompt);
        return env->NewStringUTF("Error: Model not loaded");
    }
    
    // Формируем полный промпт в формате ChatML / Instruction
    std::stringstream ss;
    ss << "<|system|>\n" << system_prompt << "\n";
    ss << "<|user|>\n" << user_prompt << "\n";
    ss << "<|assistant|>\n";
    
    std::string full_prompt = ss.str();
    
    // Токенизируем вход
    std::vector<llama_token> tokens;
    tokens.resize(full_prompt.size() + 256); // Грубая оценка
    
    int32_t n_tokens = llama_tokenize(
        llama_get_model(g_context),
        full_prompt.c_str(),
        full_prompt.size(),
        tokens.data(),
        tokens.size(),
        true,  // add_special
        true   // parse_special
    );
    
    if (n_tokens < 0) {
        LOGE("Tokenization failed");
        env->ReleaseStringUTFChars(systemPrompt, system_prompt);
        env->ReleaseStringUTFChars(userPrompt, user_prompt);
        return env->NewStringUTF("Error: Tokenization failed");
    }
    
    // Параметры генерации
    struct llama_sampling_params sampling_params;
    sampling_params.temp = g_params.temperature;
    sampling_params.top_k = g_params.top_k;
    sampling_params.top_p = g_params.top_p;
    
    // Генерируем токены
    std::string result = "";
    llama_batch batch = llama_batch_get_one(tokens.data(), n_tokens);
    
    // Process prompt
    int32_t n_past = 0;
    while (batch.n_tokens > 0) {
        if (llama_decode(g_context, batch) != 0) {
            LOGE("llama_decode failed");
            break;
        }
        
        batch.n_tokens = 0;
        batch.token[0] = llama_sample_token(g_context, nullptr);
        batch.n_tokens = 1;
        
        if (batch.token[0] == llama_token_eos(llama_get_model(g_context))) {
            break;
        }
        
        result += llama_token_to_piece(llama_get_model(g_context), batch.token[0]);
        n_past++;
    }
    
    env->ReleaseStringUTFChars(systemPrompt, system_prompt);
    env->ReleaseStringUTFChars(userPrompt, user_prompt);
    
    LOGD("Generated %zu characters", result.size());
    return env->NewStringUTF(result.c_str());
    
#else
    // Stub реализация для компиляции без llama.cpp
    env->ReleaseStringUTFChars(systemPrompt, system_prompt);
    env->ReleaseStringUTFChars(userPrompt, user_prompt);
    
    std::string stub_response = 
        "# Stub Response\n\n"
        "llama.cpp не подключен. Для работы необходимо:\n"
        "1. Клонируйте llama.cpp в директорию cpp/\n"
        "2. Соберите нативные библиотеки\n"
        "3. Поместите модель Qwen2.5-1.5B-Instruct в формате GGUF\n\n"
        "Получен системный промпт длиной: " + std::to_string(strlen(system_prompt)) + " символов\n"
        "Получен пользовательский запрос длиной: " + std::to_string(strlen(user_prompt)) + " символов";
    
    return env->NewStringUTF(stub_response.c_str());
#endif
}

/**
 * Установить параметры генерации
 */
JNIEXPORT void JNICALL
Java_com_tglocaldigest_llama_LlamaCppModel_setGenerationParams(
    JNIEnv* env,
    jobject thiz,
    jint threads,
    jint contextSize,
    jint batchSize,
    jint maxTokens,
    jfloat temperature
) {
    g_params.n_threads = threads;
    g_params.n_ctx = contextSize;
    g_params.n_batch = batchSize;
    g_params.n_predict = maxTokens;
    g_params.temperature = temperature;
    
    LOGD("Generation params updated: threads=%d, ctx=%d, temp=%.2f", 
         threads, contextSize, temperature);
}

/**
 * Проверить загружена ли модель
 */
JNIEXPORT jboolean JNICALL
Java_com_tglocaldigest_llama_LlamaCppModel_isModelLoaded(JNIEnv* env, jobject thiz) {
#ifdef LLAMA_CPP_AVAILABLE
    return (g_model != nullptr && g_context != nullptr) ? JNI_TRUE : JNI_FALSE;
#else
    return JNI_FALSE;
#endif
}

/**
 * Получить информацию о модели
 */
JNIEXPORT jstring JNICALL
Java_com_tglocaldigest_llama_LlamaCppModel_getModelInfo(JNIEnv* env, jobject thiz) {
#ifdef LLAMA_CPP_AVAILABLE
    if (g_model != nullptr) {
        auto* model = static_cast<llama_model*>(g_model);
        size_t size = llama_model_size(model);
        size_t n_params = llama_model_n_params(model);
        
        std::stringstream ss;
        ss << "Model loaded\n";
        ss << "Size: " << (size / 1024 / 1024) << " MB\n";
        ss << "Parameters: " << n_params;
        
        return env->NewStringUTF(ss.str().c_str());
    }
#endif
    return env->NewStringUTF("Model not loaded");
}

} // extern "C"
