const EXACT_TEXT: Record<string, string> = {
  "Settings": "Настройки",
  "Connect to your server": "Подключитесь к своему серверу",
  "Self-hosted chat — Your server, your rules": "Свой чат-сервер — ваши правила, ваш контроль",
  "Login": "Войти",
  "Register": "Регистрация",
  "Server Address": "Адрес сервера",
  "Username": "Имя пользователя",
  "Password": "Пароль",
  "Invite Code": "Код приглашения",
  "Remember password": "Запомнить пароль",
  "Need an account? Register": "Нет аккаунта? Зарегистрируйтесь",
  "Already have an account? Login": "Уже есть аккаунт? Войдите",
  "Toggle password visibility": "Показать или скрыть пароль",
  "Two-Factor Authentication": "Двухфакторная аутентификация",
  "Enter the 6-digit code from your authenticator app.": "Введите 6-значный код из приложения-аутентификатора.",
  "Verify": "Подтвердить",
  "Cancel": "Отмена",
  "Auto-connecting...": "Автоподключение...",
  "Servers": "Серверы",
  "+ Add Server": "+ Добавить сервер",
  "Local Server": "Локальный сервер",
  "Disable auto-login": "Отключить автовход",
  "Enable auto-login": "Включить автовход",
  "Auto-login enabled": "Автовход включен",
  "Delete server": "Удалить сервер",
  "Add Server": "Добавить сервер",
  "Server Name": "Название сервера",
  "My Server": "Мой сервер",
  "Host Address": "Адрес хоста",
  "Connected!": "Подключено!",
  "Loading server data...": "Загружаем данные сервера...",
  "Ready!": "Готово!",
  "Certificate Warning": "Предупреждение о сертификате",
  "Certificate Changed": "Сертификат изменился",
  "Disconnect": "Отключиться",
  "Accept New Certificate": "Принять новый сертификат",
  "Host": "Хост",
  "Previous": "Предыдущий",
  "Current": "Текущий",
  "Unknown": "Неизвестно",
  "Account": "Учетная запись",
  "Appearance": "Внешний вид",
  "Notifications": "Уведомления",
  "Text & Images": "Текст и изображения",
  "Accessibility": "Специальные возможности",
  "Voice & Audio": "Голос и аудио",
  "Keybinds": "Горячие клавиши",
  "Advanced": "Дополнительно",
  "Logs": "Журналы",
  "Edit Profile": "Изменить профиль",
  "User Settings": "Настройки пользователя",
  "App Settings": "Настройки приложения",
  "Log Out": "Выйти",
  "Edit User Profile": "Изменить профиль",
  "Password and Authentication": "Пароль и аутентификация",
  "Old password": "Текущий пароль",
  "New password": "Новый пароль",
  "Confirm new password": "Подтвердите новый пароль",
  "Change Password": "Сменить пароль",
  "Passwords do not match.": "Пароли не совпадают.",
  "Password changed successfully.": "Пароль успешно изменен.",
  "Add an extra layer of security to your account.": "Добавьте дополнительный уровень защиты для своей учетной записи.",
  "Enable 2FA": "Включить 2FA",
  "Enter your password": "Введите пароль",
  "Submit": "Отправить",
  "Password is required.": "Пароль обязателен.",
  "Requesting...": "Отправка...",
  "Failed to enable 2FA.": "Не удалось включить 2FA.",
  "Scan this URI with your authenticator app, or copy it manually:": "Отсканируйте этот URI приложением-аутентификатором или скопируйте его вручную:",
  "Save these backup codes in a safe place:": "Сохраните эти резервные коды в надежном месте:",
  "6-digit code": "6-значный код",
  "Verify & Activate": "Проверить и включить",
  "Please enter the 6-digit code.": "Введите 6-значный код.",
  "Invalid verification code.": "Неверный код подтверждения.",
  "Your account is protected with 2FA.": "Ваша учетная запись защищена 2FA.",
  "Disable 2FA": "Отключить 2FA",
  "Confirm Disable": "Подтвердить отключение",
  "Disabling...": "Отключение...",
  "2FA is required by this server and cannot be disabled": "2FA обязательно на этом сервере и не может быть отключена",
  "Enabled": "Включено",
  "Disabled": "Отключено",
  "Online": "В сети",
  "Idle": "Нет на месте",
  "Do Not Disturb": "Не беспокоить",
  "Offline": "Не в сети",
  "You will appear as idle": "Вы будете отображаться как «Нет на месте»",
  "You will not receive desktop notifications": "Вы не будете получать уведомления на рабочем столе",
  "You will appear offline but still have full access": "Вы будете отображаться офлайн, но сохраните полный доступ",
  "Status": "Статус",
  "Deleting...": "Удаление...",
  "Confirm Delete": "Подтвердить удаление",
  "New username": "Новое имя пользователя",
  "Save": "Сохранить",
  "Developer Mode": "Режим разработчика",
  "Show message IDs, user IDs, and channel IDs on context menus": "Показывать ID сообщений, пользователей и каналов в контекстных меню",
  "Hardware Acceleration": "Аппаратное ускорение",
  "Use GPU for rendering. Requires restart to take effect": "Использовать GPU для рендеринга. Требуется перезапуск.",
  "Debug": "Отладка",
  "Open DevTools": "Открыть DevTools",
  "Open the browser developer tools for debugging": "Открыть инструменты разработчика браузера для отладки",
  "Storage & Cache": "Хранилище и кэш",
  "Theme": "Тема",
  "Dark": "Темная",
  "Neon-glow": "Неоновая",
  "Midnight": "Полночь",
  "Light": "Светлая",
  "Font Size": "Размер шрифта",
  "Compact Mode": "Компактный режим",
  "Accent Color": "Акцентный цвет",
  "Desktop Notifications": "Уведомления на рабочем столе",
  "Show desktop notifications for messages": "Показывать уведомления о сообщениях на рабочем столе",
  "Flash Taskbar": "Подсвечивать панель задач",
  "Flash taskbar on new messages": "Подсвечивать панель задач при новых сообщениях",
  "Suppress @everyone": "Отключить @everyone",
  "Mute @everyone and @here mentions": "Заглушить упоминания @everyone и @here",
  "Notification Sounds": "Звуки уведомлений",
  "Play sounds for notifications": "Воспроизводить звуки уведомлений",
  "Link Preview": "Предпросмотр ссылок",
  "Show website previews for links shared in chat": "Показывать предпросмотр сайтов для ссылок из чата",
  "Show Embeds": "Показывать встраивания",
  "Display rich embeds in chat messages": "Показывать богатые превью в сообщениях",
  "Inline Attachment Preview": "Встроенный предпросмотр вложений",
  "Automatically display images, videos, and GIFs inline": "Автоматически показывать изображения, видео и GIF прямо в сообщениях",
  "Animate GIFs": "Анимировать GIF",
  "Play GIF animations automatically. When disabled, GIFs show as static images": "Автоматически воспроизводить GIF. Если отключить, GIF будут показаны как статичные изображения",
  "Reduce Motion": "Уменьшить анимацию",
  "Disable animations and transitions": "Отключить анимации и переходы",
  "High Contrast": "Высокая контрастность",
  "Increase contrast for better readability": "Повысить контрастность для лучшей читаемости",
  "Role Colors": "Цвета ролей",
  "Show colored usernames based on role in chat": "Показывать цветные имена пользователей в зависимости от роли",
  "Sync with OS": "Синхронизировать с ОС",
  "Automatically enable reduced motion based on your OS accessibility settings": "Автоматически включать уменьшение анимации по настройкам специальных возможностей ОС",
  "Large Font": "Крупный шрифт",
  "Use larger text throughout the app for better readability": "Использовать более крупный текст во всем приложении для лучшей читаемости",
  "Input Device": "Устройство ввода",
  "Default": "По умолчанию",
  "Input Volume": "Громкость ввода",
  "Input Sensitivity": "Чувствительность микрофона",
  "Output Device": "Устройство вывода",
  "Output Volume": "Громкость вывода",
  "Stream Quality": "Качество трансляции",
  "Applies to camera and screenshare. Higher quality uses more bandwidth. Changes take effect on next voice join.": "Применяется к камере и демонстрации экрана. Более высокое качество требует больше трафика. Изменения вступят в силу при следующем входе в голосовой канал.",
  "Low (360p cam / 720p screen)": "Низкое (камера 360p / экран 720p)",
  "Medium (720p)": "Среднее (720p)",
  "High (1080p)": "Высокое (1080p)",
  "Source (1080p max bitrate)": "Исходное (1080p, максимальный битрейт)",
  "Video Device": "Видеоустройство",
  "Could not enumerate devices": "Не удалось получить список устройств",
  "Camera unavailable": "Камера недоступна",
  "Echo Cancellation": "Эхоподавление",
  "Reduce echo from speakers feeding back into microphone": "Уменьшать эхо от динамиков, попадающее в микрофон",
  "Noise Suppression": "Шумоподавление",
  "Filter out background noise from your microphone": "Убирать фоновый шум с микрофона",
  "Automatic Gain Control": "Автоматическая регулировка усиления",
  "Automatically adjust microphone volume": "Автоматически настраивать громкость микрофона",
  "Enhanced Noise Suppression": "Улучшенное шумоподавление",
  "ML-powered noise removal (RNNoise) — filters keyboard, pets, and other non-voice sounds": "Удаление шума на базе ML (RNNoise) — убирает клавиатуру, животных и другие посторонние звуки",
  "Clear Logs": "Очистить журналы",
  "Refresh": "Обновить",
  "Voice Diagnostics": "Диагностика голоса",
  "Refresh Diagnostics": "Обновить диагностику",
  "Copy Diagnostics": "Скопировать диагностику",
  "Push to Talk": "Нажми и говори",
  "Click to set keybind": "Нажмите, чтобы назначить клавишу",
  "Push to Talk keybind — click to capture": "Горячая клавиша «Нажми и говори» — нажмите для захвата",
  "Not set": "Не задано",
  "Clear": "Очистить",
  "Press any key...": "Нажмите любую клавишу...",
  "PTT works globally and does not hijack the key — you can still type and use other apps normally. Mouse buttons (Mouse 4/5) also work.": "PTT работает глобально и не перехватывает клавишу — вы по-прежнему можете печатать и пользоваться другими приложениями. Кнопки мыши (Mouse 4/5) тоже поддерживаются.",
  "Navigation": "Навигация",
  "Quick Switcher": "Быстрое переключение",
  "Mark as Read": "Пометить как прочитанное",
  "Search Messages": "Поиск сообщений",
  "Communication": "Связь",
  "Toggle Mute": "Переключить микрофон",
  "Toggle Deafen": "Переключить оглушение",
  "Toggle Camera": "Переключить камеру",
  "Upload File": "Загрузить файл",
  "Edit Last Message": "Изменить последнее сообщение",
  "Download": "Скачать",
  "Copy": "Копировать",
  "Copied!": "Скопировано!",
  "Failed": "Ошибка",
  "Reply to unknown message": "Ответ на неизвестное сообщение",
  "[message deleted]": "[сообщение удалено]",
  "(edited)": "(изменено)",
  "React": "Реакция",
  "Reply": "Ответить",
  "Pin": "Закрепить",
  "Unpin": "Открепить",
  "Edit": "Изменить",
  "Delete": "Удалить",
  "Copy ID": "Копировать ID",
  "Search...": "Поиск...",
  "New Direct Message": "Новое личное сообщение",
  "Message deleted": "Сообщение удалено",
  "Click delete again to confirm": "Нажмите удалить еще раз для подтверждения",
  "Message unpinned": "Сообщение откреплено",
  "Message pinned": "Сообщение закреплено",
  "Failed to pin/unpin message": "Не удалось закрепить или открепить сообщение",
  "Not connected — message not sent": "Нет подключения — сообщение не отправлено",
  "File upload failed": "Не удалось загрузить файл",
  "Message cannot be empty": "Сообщение не может быть пустым",
  "Message edited": "Сообщение изменено",
  "Failed to load invites": "Не удалось загрузить приглашения",
  "Message not in loaded window": "Сообщение отсутствует в загруженном окне",
  "Failed to unpin message": "Не удалось открепить сообщение",
  "Failed to load pinned messages": "Не удалось загрузить закрепленные сообщения",
  "Search failed": "Поиск не удался",
  "Message not in loaded history": "Сообщение отсутствует в загруженной истории",
  "Invite people": "Пригласить людей",
  "Server": "Сервер",
  "DIRECT MESSAGES": "ЛИЧНЫЕ СООБЩЕНИЯ",
  "New DM": "Новое ЛС",
  "MEMBERS": "УЧАСТНИКИ",
  "Voice Connected": "Голосовое подключение",
  "Connection quality": "Качество соединения",
  "Transport Statistics": "Статистика транспорта",
  "Outgoing": "Исходящий",
  "Incoming": "Входящий",
  "Session Totals": "Итоги сеанса",
  "Grant microphone permission": "Разрешить доступ к микрофону",
  "Grant Microphone": "Разрешить микрофон",
  "Voice Channel": "Голосовой канал",
  "Reconnecting...": "Переподключение...",
  "Friends": "Друзья",
  "Direct Messages": "Личные сообщения",
  "Return to channels": "Вернуться к каналам",
  "Find a conversation": "Найти диалог",
  "Close DM": "Закрыть ЛС",
  "Reset Volume": "Сбросить громкость",
  "No channels yet": "Каналов пока нет",
  "Right-click a category to create one": "Нажмите правой кнопкой по категории, чтобы создать канал",
  "Create Channel": "Создать канал",
  "Name": "Название",
  "Type": "Тип",
  "Channel name is required": "Название канала обязательно",
  "Creating...": "Создание...",
  "Delete Channel": "Удалить канал",
  "Edit Channel": "Редактировать канал",
  "Saving...": "Сохранение...",
  "Save Changes": "Сохранить изменения",
  "Search emoji...": "Поиск эмодзи...",
  "Recent": "Недавние",
  "Custom": "Свои",
  "Smileys": "Смайлы",
  "People": "Люди",
  "Nature": "Природа",
  "Food": "Еда",
  "Objects": "Предметы",
  "Symbols": "Символы",
  "No emoji found": "Эмодзи не найдены",
  "Where do you want to go?": "Куда перейти?",
  "Switch Server": "Переключить сервер",
  "You’ll disconnect from the current server.": "Вы отключитесь от текущего сервера.",
  "Connected": "Подключено",
  "Add new server": "Добавить новый сервер",
  "Connect to another Rylo server": "Подключиться к другому серверу Rylo",
  "Press Escape to cancel": "Нажмите Escape для отмены",
  "Search messages...": "Поиск сообщений...",
  "Search messages": "Поиск сообщений",
  "Pinned Messages": "Закрепленные сообщения",
  "Jump to message": "Перейти к сообщению",
  "Unpin message": "Открепить сообщение",
  "This channel doesn't have any pinned messages… yet!": "В этом канале пока нет закрепленных сообщений…",
  "Switch server": "Переключить сервер",
  "Volume": "Громкость",
  "Mute": "Выключить звук",
  "Update Now": "Обновить сейчас",
  "Later": "Позже",
  "Downloading update...": "Загрузка обновления...",
  "Update failed. Please try again later.": "Не удалось установить обновление. Попробуйте позже.",
  "Dismiss": "Закрыть",
  "Someone": "Кто-то",
  "Several people are typing...": "Несколько человек печатают...",
  "Welcome to Rylo": "Добро пожаловать в Rylo",
  "No accounts exist yet. Create the owner account to get started.": "Пока не создано ни одной учетной записи. Создайте учетную запись владельца, чтобы начать.",
  "Choose a username": "Придумайте имя пользователя",
  "Min 8 characters": "Минимум 8 символов",
  "Confirm Password": "Подтвердите пароль",
  "Re-enter password": "Повторите пароль",
  "Create Owner Account": "Создать учетную запись владельца",
  "Setup Complete!": "Настройка завершена!",
  "Your owner account has been created. Here's your invite code:": "Учетная запись владельца создана. Вот ваш код приглашения:",
  "Save this code! Share it with people you want to invite.": "Сохраните этот код! Поделитесь им с теми, кого хотите пригласить.",
  "Continue to Admin Panel": "Перейти в панель администратора",
  "Rylo Admin": "Администрирование Rylo",
  "Sign In": "Войти",
  "Admin Panel": "Панель администратора",
  "Admin sections": "Разделы администрирования",
  "Dashboard": "Панель",
  "Server overview and statistics": "Обзор сервера и статистика",
  "View Update": "Открыть обновление",
  "Total Users": "Всего пользователей",
  "registered": "зарегистрировано",
  "Messages": "Сообщения",
  "total": "всего",
  "Channels": "Каналы",
  "active": "активных",
  "Recent Activity": "Последняя активность",
  "View All": "Показать все",
  "Backups": "Резервные копии",
  "Database backup and restore": "Резервное копирование и восстановление базы данных",
  "Manual Backup": "Ручная копия",
  "Running...": "Выполняется...",
  "Create Backup Now": "Создать резервную копию",
  "Schedule": "Расписание",
  "Configure backup schedule in Settings.": "Настройте расписание резервного копирования в разделе «Настройки».",
  "Go to Settings": "Перейти в настройки",
  "Backup History": "История резервных копий",
  "Filename": "Имя файла",
  "Size": "Размер",
  "Date": "Дата",
  "Actions": "Действия",
  "No backups found": "Резервные копии не найдены",
  "Signed out": "Вы вышли",
  "Users": "Пользователи",
  "Invites": "Приглашения",
  "Moderation": "Модерация",
  "Backup": "Резервные копии",
  "Updates": "Обновления",
  "Logout": "Выход",
  "Owner": "Владелец",
  "Admin": "Администратор",
  "Moderator": "Модератор",
  "Member": "Участник",
  "Users Online": "Пользователей онлайн",
  "Messages Today": "Сообщений сегодня",
  "Voice Active": "Активно в голосе",
  "connections": "подключений",
  "Disk Usage": "Использование диска",
  "CPU": "ЦП",
  "Uptime": "Время работы",
  "Online Users": "Пользователи онлайн",
  "Search users...": "Поиск пользователей...",
  "All roles": "Все роли",
  "All statuses": "Все статусы",
  "Created": "Создан",
  "Last Seen": "Последний вход",
  "No users found": "Пользователи не найдены",
  "Banned": "Заблокирован",
  "Create Invite": "Создать приглашение",
  "Expires": "Истекает",
  "Never": "Никогда",
  "Used": "Использовано",
  "Max Uses": "Макс. использований",
  "Security": "Безопасность",
  "Settings saved": "Настройки сохранены",
  "Live log stream": "Поток журналов",
  "Pause": "Пауза",
  "Resume": "Продолжить",
  "Search logs...": "Поиск по журналам...",
  "Username and password are required.": "Имя пользователя и пароль обязательны.",
  "Server address is required.": "Адрес сервера обязателен.",
  "Invite code is required for registration.": "Для регистрации требуется код приглашения.",
  "Verification failed.": "Проверка не удалась.",
  "Could not save credentials — auto-login won't work": "Не удалось сохранить учетные данные — автовход не будет работать",
  "invalid invite or credentials": "Неверный код приглашения или учетные данные",
  "failed to load registration policy": "Не удалось загрузить политику регистрации",
  "registration is currently closed": "Регистрация сейчас закрыта",
  "registration is unavailable while two-factor authentication is required": "Регистрация недоступна, пока на сервере требуется двухфакторная аутентификация",
  "malformed request body": "Некорректное тело запроса",
  "username, password, and invite_code are required": "Требуются имя пользователя, пароль и invite_code",
  "failed to process registration": "Не удалось обработать регистрацию",
  "registration failed — please try again": "Регистрация не удалась — попробуйте снова",
  "failed to create session": "Не удалось создать сессию",
  "registration succeeded but user fetch failed": "Регистрация выполнена, но не удалось получить пользователя",
  "username and password are required": "Имя пользователя и пароль обязательны",
  "account temporarily locked due to too many failed attempts": "Учетная запись временно заблокирована из-за большого числа неудачных попыток",
  "login temporarily unavailable": "Вход временно недоступен",
  "invalid credentials": "Неверные учетные данные",
  "your account has been suspended": "Ваша учетная запись заблокирована",
  "failed to load authentication policy": "Не удалось загрузить политику аутентификации",
  "failed to start two-factor challenge": "Не удалось запустить двухфакторную проверку",
  "two-factor authentication must be enabled on this account before login": "Для входа в эту учетную запись необходимо включить двухфакторную аутентификацию",
  "missing or invalid authorization header": "Отсутствует или неверен заголовок авторизации",
  "invalid or expired two-factor challenge": "Двухфакторная проверка недействительна или истекла",
  "invalid two-factor code": "Неверный код двухфакторной аутентификации",
  "not authenticated": "Требуется авторизация",
  "failed to generate two-factor secret": "Не удалось сгенерировать секрет для двухфакторной аутентификации",
  "no pending two-factor enrollment found": "Не найдено ожидающее подтверждения подключение 2FA",
  "failed to enable two-factor authentication": "Не удалось включить двухфакторную аутентификацию",
  "two-factor authentication is required for this server": "На этом сервере требуется двухфакторная аутентификация",
  "failed to disable two-factor authentication": "Не удалось отключить двухфакторную аутентификацию",
  "failed to logout": "Не удалось выйти",
  "too many failed attempts, try again later": "Слишком много неудачных попыток, попробуйте позже",
  "password is required": "Пароль обязателен",
  "incorrect password": "Неверный пароль",
  "cannot delete the last admin account": "Нельзя удалить последнюю учетную запись администратора",
  "failed to delete account": "Не удалось удалить учетную запись",
  "too many requests, please slow down": "Слишком много запросов, пожалуйста, замедлитесь",
  "failed to list channels": "Не удалось получить список каналов",
  "failed to fetch channel permissions": "Не удалось получить права канала",
  "failed to look up channel": "Не удалось найти канал",
  "channel not found": "Канал не найден",
  "authentication required": "Требуется авторизация",
  "not a participant in this DM": "Вы не участник этого личного диалога",
  "no permission to view this channel": "Недостаточно прав для просмотра этого канала",
  "before must be a non-negative integer": "Параметр before должен быть неотрицательным целым числом",
  "limit must be a positive integer": "Параметр limit должен быть положительным целым числом",
  "failed to fetch messages": "Не удалось получить сообщения",
  "query parameter 'q' is required": "Требуется параметр запроса 'q'",
  "channel_id must be a positive integer": "channel_id должен быть положительным целым числом",
  "invalid search query": "Некорректный поисковый запрос",
  "search failed": "Поиск не удался",
  "failed to fetch pinned messages": "Не удалось получить закрепленные сообщения",
  "no permission to manage messages in this channel": "Недостаточно прав для управления сообщениями в этом канале",
  "failed to look up message": "Не удалось найти сообщение",
  "message not found": "Сообщение не найдено",
  "missing target or current_version": "Отсутствует target или current_version",
  "failed to check for updates": "Не удалось проверить обновления",
  "failed to fetch signature": "Не удалось получить подпись",
  "invalid request body": "Некорректное тело запроса",
  "recipient_id must be a positive integer": "recipient_id должен быть положительным целым числом",
  "cannot create a DM with yourself": "Нельзя создать личный чат с самим собой",
  "failed to look up recipient": "Не удалось найти получателя",
  "recipient not found": "Получатель не найден",
  "failed to create DM channel": "Не удалось создать личный канал",
  "failed to list DM channels": "Не удалось получить список личных чатов",
  "failed to verify DM participation": "Не удалось проверить участие в личном чате",
  "you are not a participant in this DM": "Вы не участник этого личного диалога",
  "failed to close DM": "Не удалось закрыть личный диалог",
  "malformed JSON body": "Некорректное JSON-тело запроса",
  "failed to create invite": "Не удалось создать приглашение",
  "failed to retrieve invite": "Не удалось получить приглашение",
  "failed to list invites": "Не удалось получить список приглашений",
  "failed to look up invite": "Не удалось найти приглашение",
  "invite not found": "Приглашение не найдено",
  "failed to revoke invite": "Не удалось отозвать приглашение",
  "access denied": "Доступ запрещен",
  "backend unavailable": "Серверная часть недоступна",
  "invalid or expired session": "Сессия недействительна или истекла",
  "session has expired": "Срок действия сессии истек",
  "user not found": "Пользователь не найден",
  "role not found": "Роль не найдена",
  "insufficient permissions": "Недостаточно прав",
  "internal server error": "Внутренняя ошибка сервера",
  "invalid chat_send payload": "Некорректная нагрузка chat_send",
  "failed to check DM participation": "Не удалось проверить участие в личном диалоге",
  "channel has 1s slow mode": "В канале включен slow mode 1 с",
  "message content cannot be empty": "Содержимое сообщения не может быть пустым",
  "message content exceeds maximum length of 4000 characters": "Содержимое сообщения превышает максимальную длину 4000 символов",
  "failed to save message": "Не удалось сохранить сообщение",
  "failed to send message with attachments": "Не удалось отправить сообщение с вложениями",
  "failed to retrieve message": "Не удалось получить сообщение",
  "message saved but delivery failed — please retry": "Сообщение сохранено, но доставка не удалась — попробуйте еще раз",
  "invalid chat_edit payload": "Некорректная нагрузка chat_edit",
  "message_id must be positive integer": "message_id должен быть положительным целым числом",
  "content cannot be empty": "Содержимое не может быть пустым",
  "message too long": "Сообщение слишком длинное",
  "cannot edit this message": "Нельзя изменить это сообщение",
  "edit saved but broadcast failed": "Изменения сохранены, но не удалось разослать обновление",
  "invalid chat_delete payload": "Некорректная нагрузка chat_delete",
  "cannot delete this message": "Нельзя удалить это сообщение",
  "status must be online|idle|dnd|offline": "Статус должен быть online|idle|dnd|offline",
  "failed to update status": "Не удалось обновить статус",
  "invalid reaction payload": "Некорректная нагрузка реакции",
  "emoji cannot be empty": "Эмодзи не может быть пустым",
  "emoji too long": "Эмодзи слишком длинный",
  "emoji contains invalid characters": "Эмодзи содержит недопустимые символы",
  "reaction failed": "Не удалось применить реакцию",
  "you are banned": "Вы заблокированы",
  "message must be valid JSON": "Сообщение должно быть корректным JSON",
  "failed to build ready payload": "Не удалось подготовить начальные данные ready",
  "failed to broadcast voice state update": "Не удалось разослать обновление голосового состояния",
  "not in a voice channel": "Вы не находитесь в голосовом канале",
  "invalid voice_mute payload": "Некорректная нагрузка voice_mute",
  "failed to update mute state": "Не удалось обновить состояние микрофона",
  "invalid voice_deafen payload": "Некорректная нагрузка voice_deafen",
  "failed to update deafen state": "Не удалось обновить состояние оглушения",
  "invalid voice_camera payload": "Некорректная нагрузка voice_camera",
  "failed to check video limit": "Не удалось проверить лимит видео",
  "failed to update camera state": "Не удалось обновить состояние камеры",
  "invalid voice_screenshare payload": "Некорректная нагрузка voice_screenshare",
  "failed to update screenshare state": "Не удалось обновить состояние демонстрации экрана",
  "voice is not configured on this server": "Голосовая связь не настроена на этом сервере",
  "voice is temporarily unavailable — LiveKit is not running": "Голосовая связь временно недоступна — LiveKit не запущен",
  "already in this voice channel": "Вы уже находитесь в этом голосовом канале",
  "failed to check channel capacity": "Не удалось проверить вместимость канала",
  "voice channel is full": "Голосовой канал заполнен",
  "failed to join voice channel": "Не удалось войти в голосовой канал",
  "failed to generate voice token": "Не удалось создать голосовой токен",
  "not in voice": "Вы не в голосовом канале",
  "voice not configured": "Голосовая связь не настроена",
  "voice leave failed — please rejoin if issues persist": "Не удалось корректно покинуть голосовой канал — при необходимости войдите снова",
};

const DYNAMIC_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replace: (...args: string[]) => string;
}> = [
  { pattern: /^Logged in as (.+)$/, replace: (_m, user) => `Вы вошли как ${user}` },
  { pattern: /^(\d+)\s+online$/, replace: (_m, count) => `${count} онлайн` },
  { pattern: /^View all messages \((\d+)\)$/, replace: (_m, count) => `Показать все сообщения (${count})` },
  { pattern: /^User Volume:\s*(\d+)%$/, replace: (_m, volume) => `Громкость пользователя: ${volume}%` },
  { pattern: /^Password must be at least (\d+) characters\.$/, replace: (_m, min) => `Пароль должен содержать не менее ${min} символов.` },
  { pattern: /^New password must be at least (\d+) characters\.$/, replace: (_m, min) => `Новый пароль должен содержать не менее ${min} символов.` },
  { pattern: /^Username must be 2[-–](\d+) characters\.$/, replace: (_m, max) => `Имя пользователя должно быть длиной от 2 до ${max} символов.` },
  { pattern: /^Type at least (\d+) characters$/, replace: (_m, count) => `Введите минимум ${count} символа(ов)` },
  { pattern: /^Update v(.+) available$/, replace: (_m, version) => `Доступно обновление v${version}` },
  { pattern: /^Auto-login failed: (.+)$/, replace: (_m, message) => `Автовход не удался: ${message}` },
  { pattern: /^(.+) is typing\.\.\.$/, replace: (_m, user) => `${user} печатает...` },
  { pattern: /^(.+) and (.+) are typing\.\.\.$/, replace: (_m, first, second) => `${first} и ${second} печатают...` },
  { pattern: /^Update Available:\s*(.+)$/, replace: (_m, version) => `Доступно обновление: ${version}` },
  { pattern: /^Current:\s*(.+)$/, replace: (_m, version) => `Текущая версия: ${version}` },
  { pattern: /^of (\d+) total$/, replace: (_m, count) => `из ${count} всего` },
  { pattern: /^maximum (\d+) video streams reached$/, replace: (_m, count) => `Достигнут максимум в ${count} видеопотоков` },
  { pattern: /^channel has (\d+)s slow mode$/, replace: (_m, seconds) => `В канале включен slow mode ${seconds} с` },
  { pattern: /^unknown message type: (.+)$/, replace: (_m, messageType) => `Неизвестный тип сообщения: ${messageType}` },
  { pattern: /^missing (.+) permission$/, replace: (_m, permission) => `Отсутствует право ${permission}` },
  { pattern: /^Microphone \((.+)\)$/, replace: (_m, id) => `Микрофон (${id})` },
  { pattern: /^Speaker \((.+)\)$/, replace: (_m, id) => `Динамик (${id})` },
  { pattern: /^Camera \((.+)\)$/, replace: (_m, id) => `Камера (${id})` },
];

const TRANSLATABLE_ATTRS = new Set(["placeholder", "title", "aria-label"]);

function shouldSkipTranslation(value: string): boolean {
  return value === ""
    || /^(https?:\/\/|wss?:\/\/)/i.test(value)
    || /^[\w.-]+:\d+$/.test(value)
    || /^[A-Fa-f0-9:]{16,}$/.test(value)
    || /^[A-Z0-9_-]{16,}$/.test(value)
    || /^#[0-9A-Fa-f]{3,8}$/.test(value)
    || value.includes("localhost")
    || value.includes(".com")
    || value.includes(".net");
}

function splitPadding(value: string): { readonly leading: string; readonly core: string; readonly trailing: string } {
  const match = /^(\s*)(.*?)(\s*)$/s.exec(value);
  return {
    leading: match?.[1] ?? "",
    core: match?.[2] ?? value,
    trailing: match?.[3] ?? "",
  };
}

function translateCore(value: string): string | null {
  if (shouldSkipTranslation(value)) {
    return null;
  }

  const exact = EXACT_TEXT[value];
  if (exact !== undefined) {
    return exact;
  }

  for (const rule of DYNAMIC_RULES) {
    if (!rule.pattern.test(value)) {
      continue;
    }
    return value.replace(rule.pattern, (...args) => {
      const groups = args.slice(0, -2) as string[];
      return rule.replace(...groups);
    });
  }

  return null;
}

export function translateText(value: string): string {
  const { leading, core, trailing } = splitPadding(value);
  if (core === "") {
    return value;
  }
  const translated = translateCore(core);
  return translated === null ? value : `${leading}${translated}${trailing}`;
}

export function translateAttributeValue(attrName: string, value: string): string {
  if (!TRANSLATABLE_ATTRS.has(attrName)) {
    return value;
  }
  return translateText(value);
}

function translateTextNode(node: Text): void {
  const next = translateText(node.nodeValue ?? "");
  if (next !== (node.nodeValue ?? "")) {
    node.nodeValue = next;
  }
}

function translateElementAttrs(el: Element): void {
  for (const attrName of TRANSLATABLE_ATTRS) {
    const value = el.getAttribute(attrName);
    if (value === null) {
      continue;
    }
    const next = translateAttributeValue(attrName, value);
    if (next !== value) {
      el.setAttribute(attrName, next);
    }
  }
}

export function translateSubtree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text);
    return;
  }

  if (root.nodeType === Node.ELEMENT_NODE) {
    translateElementAttrs(root as Element);
  }

  for (const child of Array.from(root.childNodes)) {
    translateSubtree(child);
  }
}

export function installRussianUiTranslations(root: ParentNode = document.body): MutationObserver {
  translateSubtree(root as unknown as Node);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData" && record.target.nodeType === Node.TEXT_NODE) {
        translateTextNode(record.target as Text);
        continue;
      }

      if (record.type === "attributes" && record.target.nodeType === Node.ELEMENT_NODE) {
        translateElementAttrs(record.target as Element);
        continue;
      }

      for (const node of Array.from(record.addedNodes)) {
        translateSubtree(node);
      }
    }
  });

  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: Array.from(TRANSLATABLE_ATTRS),
  });

  return observer;
}
