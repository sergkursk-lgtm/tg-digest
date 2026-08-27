package com.tglocaldigest.llama

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

sealed class DownloadState {
    object NotStarted : DownloadState()
    data class Downloading(val progress: Float, val downloadedMB: Long, val totalMB: Long) : DownloadState()
    data class Completed(val filePath: String) : DownloadState()
    data class Error(val message: String) : DownloadState()
}

class ModelDownloader(private val context: Context) {

    private val MODEL_URL = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf"
    private val MODEL_FILENAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf"
    private val EXPECTED_SIZE_BYTES = 1150L * 1024 * 1024

    fun getModelFile(): File {
        val modelsDir = File(context.filesDir, "models")
        if (!modelsDir.exists()) {
            modelsDir.mkdirs()
        }
        return File(modelsDir, MODEL_FILENAME)
    }

    fun isModelDownloaded(): Boolean {
        val modelFile = getModelFile()
        if (!modelFile.exists()) return false
        val minSize = (EXPECTED_SIZE_BYTES * 0.95).toLong()
        return modelFile.length() >= minSize
    }

    suspend fun downloadModel(): Flow<DownloadState> = flow {
        emit(DownloadState.NotStarted)

        val modelFile = getModelFile()
        var downloadedBytes = if (modelFile.exists()) modelFile.length() else 0L

        if (downloadedBytes >= EXPECTED_SIZE_BYTES * 0.95) {
            emit(DownloadState.Completed(modelFile.absolutePath))
            return@flow
        }

        var connection: HttpURLConnection? = null
        var input: java.io.InputStream? = null
        var output: FileOutputStream? = null

        try {
            val url = URL(MODEL_URL)
            connection = url.openConnection() as HttpURLConnection
            
            connection.connectTimeout = 30000
            connection.readTimeout = 30000
            connection.instanceFollowRedirects = true
            
            if (downloadedBytes > 0) {
                connection.setRequestProperty("Range", "bytes=$downloadedBytes-")
            }

            connection.connect()

            val responseCode = connection.responseCode
            if (responseCode != HttpURLConnection.HTTP_OK && responseCode != HttpURLConnection.HTTP_PARTIAL) {
                throw Exception("Ошибка HTTP: $responseCode")
            }

            val contentLength = if (connection.contentLengthLong > 0) connection.contentLengthLong else EXPECTED_SIZE_BYTES
            val totalBytesToDownload = if (downloadedBytes > 0) (contentLength + downloadedBytes) else contentLength

            input = connection.inputStream
            output = FileOutputStream(modelFile, true)

            val buffer = ByteArray(8192)
            var bytesRead: Int
            var currentTotalDownloaded = downloadedBytes

            while (input.read(buffer).also { bytesRead = it } != -1) {
                output.write(buffer, 0, bytesRead)
                currentTotalDownloaded += bytesRead

                val progress = currentTotalDownloaded.toFloat() / totalBytesToDownload.toFloat()
                val downloadedMB = currentTotalDownloaded / (1024 * 1024)
                val totalMB = totalBytesToDownload / (1024 * 1024)

                emit(DownloadState.Downloading(progress, downloadedMB, totalMB))
            }

            output.flush()
            
            if (modelFile.length() >= (EXPECTED_SIZE_BYTES * 0.95).toLong()) {
                emit(DownloadState.Completed(modelFile.absolutePath))
            } else {
                throw Exception("Файл скачан не полностью. Размер: ${modelFile.length()}")
            }

        } catch (e: Exception) {
            emit(DownloadState.Error("Ошибка скачивания: ${e.message}"))
            e.printStackTrace()
        } finally {
            input?.close()
            output?.close()
            connection?.disconnect()
        }
    }
}
