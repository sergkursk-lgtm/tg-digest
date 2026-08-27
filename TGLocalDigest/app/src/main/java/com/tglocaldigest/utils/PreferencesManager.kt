package com.tglocaldigest.utils

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File

/**
 * Менеджер для безопасного хранения чувствительных данных
 * API ключи, токены, телефон пользователя хранятся в зашифрованном виде
 */
class SecurePreferences private constructor(context: Context) {
    
    private val sharedPreferences: SharedPreferences
    
    init {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        
        sharedPreferences = EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    
    fun saveApiKey(key: String, value: String) {
        sharedPreferences.edit().putString(key, value).apply()
    }
    
    fun getApiKey(key: String): String? {
        return sharedPreferences.getString(key, null)
    }
    
    fun savePhone(phone: String) {
        sharedPreferences.edit().putString(KEY_PHONE, phone).apply()
    }
    
    fun getPhone(): String? {
        return sharedPreferences.getString(KEY_PHONE, null)
    }
    
    fun saveChatId(chatId: Long) {
        sharedPreferences.edit().putLong(KEY_CHAT_ID, chatId).apply()
    }
    
    fun getChatId(): Long {
        return sharedPreferences.getLong(KEY_CHAT_ID, DEFAULT_CHAT_ID)
    }
    
    fun clear() {
        sharedPreferences.edit().clear().apply()
    }
    
    companion object {
        private const val PREFS_NAME = "secure_prefs"
        private const val KEY_PHONE = "phone_number"
        private const val KEY_CHAT_ID = "chat_id"
        private const val DEFAULT_CHAT_ID = -1002424956693L
        
        @Volatile
        private var instance: SecurePreferences? = null
        
        fun getInstance(context: Context): SecurePreferences {
            return instance ?: synchronized(this) {
                instance ?: SecurePreferences(context.applicationContext).also {
                    instance = it
                }
            }
        }
    }
}

/**
 * Утилиты для работы с файлами и путями
 */
object FileUtils {
    
    fun getTdlibDirectory(context: Context): File {
        return File(context.filesDir, "tdlib").apply {
            if (!exists()) mkdirs()
        }
    }
    
    fun getModelDirectory(context: Context): File {
        return File(context.filesDir, "models").apply {
            if (!exists()) mkdirs()
        }
    }
    
    fun copyAssetToFile(context: Context, assetName: String, destFile: File) {
        if (destFile.exists()) return
        
        context.assets.open(assetName).use { input ->
            destFile.outputStream().use { output ->
                input.copyTo(output)
            }
        }
    }
    
    fun getFileSize(file: File): Long {
        return if (file.exists()) file.length() else 0L
    }
}
