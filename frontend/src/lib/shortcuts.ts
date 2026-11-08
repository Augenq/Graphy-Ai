export interface Shortcut {
  label: string;
  keys: string;
  group: "Общие" | "Диалог" | "Тест";
}

export const SHORTCUTS: Shortcut[] = [
  { group: "Общие", label: "Новое занятие", keys: "Ctrl N" },
  { group: "Общие", label: "Поиск", keys: "Ctrl K" },
  { group: "Общие", label: "Боковая панель", keys: "Ctrl \\" },
  { group: "Общие", label: "Настройки", keys: "Ctrl ," },
  { group: "Общие", label: "Список горячих клавиш", keys: "Ctrl /" },
  { group: "Общие", label: "Следующая область окна", keys: "F6" },
  { group: "Общие", label: "Предыдущая область окна", keys: "Shift F6" },
  { group: "Диалог", label: "Отправить сообщение", keys: "Enter" },
  { group: "Диалог", label: "Перенос строки", keys: "Shift Enter" },
  { group: "Диалог", label: "Поставить в очередь после ответа", keys: "Alt Enter" },
  { group: "Диалог", label: "Остановить агента", keys: "Esc" },
  { group: "Диалог", label: "Прикрепить файл", keys: "Ctrl U" },
  { group: "Диалог", label: "Команды", keys: "/" },
  { group: "Диалог", label: "Материалы из чатов", keys: "@" },
  { group: "Тест", label: "Следующий / предыдущий вопрос", keys: "Alt → / Alt ←" },
  { group: "Тест", label: "Выбрать вариант", keys: "1–8 или Пробел" },
  { group: "Тест", label: "Свернуть тест", keys: "Esc" },
  { group: "Тест", label: "Отменить тест", keys: "Alt X" },
];
