# Иконка приложения

<p align="center">
  <img src="icon.svg" width="128" alt="tg-digest" />
</p>

Одна идея, нарисованная один раз: три укорачивающиеся строки — это и есть дайджест, а искра
в углу — та часть, где можно задать вопрос. Всё построено из токенов самого интерфейса
(акцентный синий, радиус карточки, скруглённые концы линий), поэтому иконка и приложение
выглядят одним целым.

Ни букв, ни мелких деталей: на 32 px три полосы всё ещё читаются, а это единственный размер,
который действительно важен.

## Файлы

| Файл | Зачем |
|---|---|
| `icon.svg` | источник. Векторный, 512×512, без текста |
| `icon-512.png` | аватар бота в Telegram (`setMyProfilePhoto`) |
| `icon-192.png` | значок приложения для Android/ярлыка |
| `icon-180.png` | `apple-touch-icon` для ярлыка на домашнем экране iOS |
| `preview.html` | служебная страница: показывает иконку в 512/192/180/128/64/48/32/24 px и на тёмном фоне |

Иконка одинаково хорошо смотрится и квадратом, и кругом: Telegram обрезает аватар в круг, и
вписанная в него карточка не задевает края.

## Как перерисовать PNG

PNG получаются из SVG тем же Chrome, что и всё остальное в проекте, — без сторонних
конвертеров:

```bash
cd frontend/branding
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for size in 512 192 180; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --default-background-color=00000000 --force-device-scale-factor=1 \
    --window-size=$size,$size --screenshot="icon-$size.png" "file://$PWD/icon.svg"
done
```

Углы остаются прозрачными: собственный радиус плитки при этом сохраняется, а Telegram всё
равно обрежет её в круг.

## Как поставить аватар бота

Из терминала, методом Bot API (так иконка и была поставлена):

```bash
curl -X POST "https://api.telegram.org/bot$TG_BOT_TOKEN/setMyProfilePhoto" \
  -F 'photo={"type":"static","photo":"attach://icon.png"}' \
  -F "icon.png=@icon-512.png"
```

Проверить, что получилось:

```bash
curl "https://api.telegram.org/bot$TG_BOT_TOKEN/getUserProfilePhotos?user_id=<id бота>"
```

Осторожно: `getMe` в текущей версии Bot API поля `photo` не отдаёт, хотя фото есть. Верить
надо `getUserProfilePhotos` — он показывает `total_count` и размеры.

Если метод недоступен в вашей версии API, то же самое делается руками: [@BotFather](https://t.me/BotFather)
→ `/mybots` → бот → **Edit Bot** → **Edit Botpic** → отправить `icon-512.png`.

## Отдельно: кнопка «Дайджесты»

Кнопка Mini App рядом с полем ввода (её ставит раздел «Приложение в Telegram» в настройках)
иконку не поддерживает — Bot API принимает только текст. Поэтому за «иконку приложения» в
Telegram отвечает именно аватар бота.
