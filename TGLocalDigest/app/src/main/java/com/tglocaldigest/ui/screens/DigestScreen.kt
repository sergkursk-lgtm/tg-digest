package com.tglocaldigest.ui.screens

import android.util.Log
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tglocaldigest.data.model.DigestResult
import com.tglocaldigest.data.repository.MessagesRepository
import com.tglocaldigest.llama.LlamaManager
import com.tglocaldigest.ui.theme.ColorPalette
import io.noties.markwon.Markwon
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * ViewModel для экрана сводок
 */
class DigestViewModel(
    private val messagesRepository: MessagesRepository,
    private val llamaManager: LlamaManager
) : ViewModel() {
    
    private val _uiState = MutableStateFlow<DigestUiState>(DigestUiState.Idle)
    val uiState: StateFlow<DigestUiState> = _uiState
    
    private val _digests = MutableStateFlow<List<DigestResult>>(emptyList())
    val digests: StateFlow<List<DigestResult>> = _digests
    
    fun generateDigest(chatId: Long, hours: Int = 24) {
        viewModelScope.launch {
            try {
                _uiState.value = DigestUiState.Loading
                
                // 1. Получаем сообщения
                Log.d(TAG, "Fetching messages for chat $chatId")
                val messages = messagesRepository.getMessagesForPeriod(chatId, hours)
                
                if (messages.isEmpty()) {
                    _uiState.value = DigestUiState.Error("Нет сообщений за выбранный период")
                    return@launch
                }
                
                _uiState.value = DigestUiState.Processing("Группировка сообщений...")
                
                // 2. Группируем по топикам
                val groupedMessages = messagesRepository.groupMessagesByTopic(messages)
                
                if (groupedMessages.isEmpty()) {
                    _uiState.value = DigestUiState.Error("Не удалось сгруппировать сообщения")
                    return@launch
                }
                
                _uiState.value = DigestUiState.Processing("Генерация сводок (${groupedMessages.size} топиков)...")
                
                // 3. Генерируем сводки через LLM
                val results = llamaManager.generateDigestsForTopics(groupedMessages)
                
                _digests.value = results
                _uiState.value = DigestUiState.Success
                
                // 4. Сохраняем результаты
                results.forEach { result ->
                    messagesRepository.saveDigestResult(result)
                }
                
                messagesRepository.updateLastDigestTime(System.currentTimeMillis())
                
            } catch (e: Exception) {
                Log.e(TAG, "Error generating digest", e)
                _uiState.value = DigestUiState.Error(e.message ?: "Неизвестная ошибка")
            }
        }
    }
    
    companion object {
        private const val TAG = "DigestViewModel"
    }
}

/**
 * Состояния UI
 */
sealed class DigestUiState {
    object Idle : DigestUiState()
    object Loading : DigestUiState()
    data class Processing(val message: String) : DigestUiState()
    object Success : DigestUiState()
    data class Error(val message: String) : DigestUiState()
}

/**
 * Экран отображения сводок с Markdown рендерингом
 */
@Composable
fun DigestScreen(
    viewModel: DigestViewModel,
    onGenerateClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()
    val digests by viewModel.digests.collectAsState()
    
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        // Заголовок
        Text(
            text = "TG Local Digest",
            style = MaterialTheme.typography.headlineMedium,
            color = ColorPalette.Primary
        )
        
        // Кнопка генерации
        Button(
            onClick = onGenerateClick,
            enabled = uiState !is DigestUiState.Loading && uiState !is DigestUiState.Processing,
            modifier = Modifier.fillMaxWidth()
        ) {
            when (uiState) {
                is DigestUiState.Loading -> Text("Загрузка...")
                is DigestUiState.Processing -> Text((uiState as DigestUiState.Processing).message)
                else -> Text("Сгенерировать сводку за 24 часа")
            }
        }
        
        // Индикатор прогресса
        if (uiState is DigestUiState.Loading || uiState is DigestUiState.Processing) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth()
            )
        }
        
        // Ошибка
        if (uiState is DigestUiState.Error) {
            Card(
                colors = CardDefaults.cardColors(containerColor = ColorPalette.Error.copy(alpha = 0.1f)),
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(
                    text = "Ошибка: ${(uiState as DigestUiState.Error).message}",
                    color = ColorPalette.Error,
                    modifier = Modifier.padding(16.dp)
                )
            }
        }
        
        // Список сводок
        LazyColumn(
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.weight(1f)
        ) {
            items(digests) { digest ->
                DigestCard(digestResult = digest)
            }
        }
    }
}

/**
 * Карточка сводки одного топика
 */
@Composable
fun DigestCard(
    digestResult: DigestResult,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        elevation = CardDefaults.cardElevation(defaultElevation = 4.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // Заголовок топика
            Text(
                text = digestResult.topicName,
                style = MaterialTheme.typography.titleLarge,
                color = ColorPalette.Primary
            )
            
            // Мета-информация
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "${digestResult.messageCount} сообщений",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.Gray
                )
                
                // Статус (парсим из Markdown)
                val status = extractStatus(digestResult.summaryMarkdown)
                StatusBadge(status)
            }
            
            Divider()
            
            // Markdown контент сводки
            MarkdownText(
                markdown = digestResult.summaryMarkdown,
                modifier = Modifier.fillMaxWidth()
            )
        }
    }
}

/**
 * Компонент для рендеринга Markdown текста
 */
@Composable
fun MarkdownText(
    markdown: String,
    modifier: Modifier = Modifier
) {
    // В реальной реализации используйте Markwon или аналогичную библиотеку
    // Для прототипа показываем текст в моноширинном шрифте
    Box(
        modifier = modifier
            .background(Color.LightGray.copy(alpha = 0.1f))
            .padding(8.dp)
    ) {
        Text(
            text = markdown,
            fontFamily = FontFamily.Monospace,
            style = MaterialTheme.typography.bodyMedium
        )
    }
}

/**
 * Бейдж статуса обсуждения
 */
@Composable
fun StatusBadge(status: String) {
    val color = when {
        status.contains("решено", ignoreCase = true) && status.contains("✓") -> ColorPalette.StatusResolved
        status.contains("не решено", ignoreCase = true) -> ColorPalette.StatusUnresolved
        else -> ColorPalette.StatusPending
    }
    
    Surface(
        color = color,
        shape = MaterialTheme.shapes.small,
        modifier = Modifier.wrapContentWidth()
    ) {
        Text(
            text = status,
            color = Color.White,
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp)
        )
    }
}

/**
 * Извлечь статус из Markdown текста
 */
private fun extractStatus(markdown: String): String {
    val statusLine = markdown.lines().find { 
        it.startsWith("Статус:", ignoreCase = true) 
    }
    return statusLine?.substringAfter("Статус:")?.trim() ?: "неизвестно"
}

private const val TAG = "DigestScreen"
