package com.tglocaldigest.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.tglocaldigest.di.DependencyInjector
import com.tglocaldigest.ui.screens.DigestScreen
import com.tglocaldigest.ui.screens.DigestViewModel

/**
 * Главная активность приложения
 * Использует Jetpack Compose для UI
 */
class MainActivity : ComponentActivity() {
    
    private lateinit var viewModel: DigestViewModel
    
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        enableEdgeToEdge()
        
        // Получаем ViewModel из DI контейнера
        viewModel = DependencyInjector.provideDigestViewModel(this)
        
        setContent {
            MaterialTheme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    DigestScreen(
                        viewModel = viewModel,
                        onGenerateClick = {
                            // Получаем Chat ID из настроек или используем дефолтный
                            val chatId = -1002424956693L // Из ТЗ для тестов
                            viewModel.generateDigest(chatId, hours = 24)
                        }
                    )
                }
            }
        }
    }
    
    override fun onDestroy() {
        super.onDestroy()
        // Ресурсы освобождаются в Application.onTerminate()
    }
}
