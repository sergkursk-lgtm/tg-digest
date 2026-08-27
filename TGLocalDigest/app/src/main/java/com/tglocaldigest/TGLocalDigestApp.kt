package com.tglocaldigest

import android.app.Application
import android.util.Log
import com.tglocaldigest.di.DependencyInjector

/**
 * Application класс для инициализации глобальных зависимостей
 */
class TGLocalDigestApp : Application() {
    
    override fun onCreate() {
        super.onCreate()
        
        Log.d(TAG, "Application starting...")
        
        // Инициализируем все зависимости
        DependencyInjector.initialize(this)
        
        Log.d(TAG, "Application initialized successfully")
    }
    
    override fun onTerminate() {
        super.onTerminate()
        
        // Освобождаем ресурсы
        DependencyInjector.release()
        
        Log.d(TAG, "Application terminated")
    }
    
    companion object {
        private const val TAG = "TGLocalDigestApp"
    }
}
