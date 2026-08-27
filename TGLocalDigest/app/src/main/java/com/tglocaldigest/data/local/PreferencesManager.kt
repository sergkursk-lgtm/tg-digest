package com.tglocaldigest.data.local

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.map
import java.io.IOException

object PreferencesKeys {
    val ONBOARDING_COMPLETED = booleanPreferencesKey("onboarding_completed")
    val AUTH_COMPLETED = booleanPreferencesKey("auth_completed")
    val SELECTED_CHAT_IDS = stringSetPreferencesKey("selected_chat_ids")
    val DIGEST_FORMAT = stringPreferencesKey("digest_format")
    val DIGEST_PERIOD_HOURS = intPreferencesKey("digest_period_hours")
}

class PreferencesManager(private val context: Context) {
    
    private val dataStore: DataStore<Preferences> = context.createDataStore(
        name = "tg_local_digest_prefs"
    )

    val onboardingCompleted: Flow<Boolean> = dataStore.data
        .catch { exception ->
            if (exception is IOException) emit(emptyPreferences()) else throw exception
        }
        .map { preferences ->
            preferences[PreferencesKeys.ONBOARDING_COMPLETED] ?: false
        }

    val authCompleted: Flow<Boolean> = dataStore.data
        .catch { exception ->
            if (exception is IOException) emit(emptyPreferences()) else throw exception
        }
        .map { preferences ->
            preferences[PreferencesKeys.AUTH_COMPLETED] ?: false
        }

    val selectedChatIds: Flow<Set<String>> = dataStore.data
        .catch { exception ->
            if (exception is IOException) emit(emptyPreferences()) else throw exception
        }
        .map { preferences ->
            preferences[PreferencesKeys.SELECTED_CHAT_IDS] ?: emptySet()
        }

    val digestFormat: Flow<String> = dataStore.data
        .catch { exception ->
            if (exception is IOException) emit(emptyPreferences()) else throw exception
        }
        .map { preferences ->
            preferences[PreferencesKeys.DIGEST_FORMAT] ?: "BRIEF"
        }

    val digestPeriodHours: Flow<Int> = dataStore.data
        .catch { exception ->
            if (exception is IOException) emit(emptyPreferences()) else throw exception
        }
        .map { preferences ->
            preferences[PreferencesKeys.DIGEST_PERIOD_HOURS] ?: 24
        }

    suspend fun setOnboardingCompleted(completed: Boolean) {
        dataStore.edit { preferences ->
            preferences[PreferencesKeys.ONBOARDING_COMPLETED] = completed
        }
    }

    suspend fun setAuthCompleted(completed: Boolean) {
        dataStore.edit { preferences ->
            preferences[PreferencesKeys.AUTH_COMPLETED] = completed
        }
    }

    suspend fun setSelectedChatIds(ids: Set<Long>) {
        dataStore.edit { preferences ->
            preferences[PreferencesKeys.SELECTED_CHAT_IDS] = ids.map { it.toString() }.toSet()
        }
    }

    suspend fun setDigestFormat(format: String) {
        dataStore.edit { preferences ->
            preferences[PreferencesKeys.DIGEST_FORMAT] = format
        }
    }

    suspend fun setDigestPeriodHours(hours: Int) {
        dataStore.edit { preferences ->
            preferences[PreferencesKeys.DIGEST_PERIOD_HOURS] = hours
        }
    }

    suspend fun clearAllData() {
        dataStore.edit { preferences ->
            preferences.clear()
        }
    }
}
