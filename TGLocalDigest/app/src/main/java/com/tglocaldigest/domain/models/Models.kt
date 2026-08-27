package com.tglocaldigest.domain.models

enum class DigestFormat(val label: String) {
    BRIEF("Краткая"),
    DETAILED("Подробная")
}

enum class TimePeriod(val hours: Int, val label: String) {
    HOURS_24(24, "24 часа"),
    HOURS_48(48, "48 часов"),
    DAYS_7(168, "7 дней"),
    CUSTOM(0, "Свой период");

    companion object {
        fun fromHours(hours: Int): TimePeriod {
            return values().find { it.hours == hours } ?: HOURS_24
        }
    }
}

data class ChatInfo(
    val id: Long,
    val title: String,
    val type: String = "unknown"
)
