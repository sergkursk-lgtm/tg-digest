package com.tglocaldigest.utils

/**
 * Словарь топиков для маппинга message_thread_id в названия
 */
object TopicsMapper {
    
    val TOPICS_MAP = mapOf(
        110846 to "Резервный канал в МАХ",
        1262 to "FAQ, часто задаваемые вопросы и ответы",
        6 to "Флудилка, болталка",
        8 to "Запчасти, расходники, ТО",
        12 to "Разное, эксплуатация",
        18 to "Сигналки и охрана",
        109862 to "Возврат страховок и навязанных доп. услуг",
        10 to "Фото/видео наших авто",
        4 to "Тюнинг и допы",
        16 to "Мультимедиа",
        114829 to "СЕРВИС. Независимость - оф. дилер Soueast",
        14 to "Шины и диски",
        1951 to "Официальные дилеры отзывы",
        1 to "Правила"
    )
    
    /**
     * Получить название топика по ID
     * @param threadId message_thread_id из сообщения
     * @return Название топика или значение по умолчанию
     */
    fun getTopicName(threadId: Int): String {
        return TOPICS_MAP[threadId] ?: "Без темы / Общий чат"
    }
    
    /**
     * Проверить существует ли топик с таким ID
     */
    fun topicExists(threadId: Int): Boolean {
        return TOPICS_MAP.containsKey(threadId)
    }
    
    /**
     * Получить все известные ID топиков
     */
    fun getAllTopicIds(): Set<Int> {
        return TOPICS_MAP.keys
    }
}
