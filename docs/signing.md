# Подпись установщика Windows (SignPath)

Сейчас `Nexus-Setup-*.exe` не подписан. Поэтому Windows показывает синее окно SmartScreen «Неизвестный издатель», а Nexus не может обновляться сам: обновление ставится кнопкой «Скачать и установить».

SignPath Foundation бесплатно подписывает open source проекты, собранные в GitHub Actions. Шаги в CI уже готовы (`.github/workflows/build.yml`). Они включаются, когда в репозитории появляются настройки SignPath, а до этого сборка идёт как раньше.

## Что нужно сделать владельцу

1. **Лицензия** — готово: проект под MIT (`LICENSE`), в README есть раздел «Code signing policy» с ролями команды и политикой конфиденциальности, как требует SignPath Foundation. Включите двухфакторную защиту GitHub: https://github.com/settings/security
2. **Заявка** на https://signpath.org (раздел для open source). SignPath проверяет проект: публичный репозиторий, сборка в CI, понятное описание. Учтите: README честно пишет, что вход в Epic использует учётные данные Epic Launcher, опубликованные Legendary. При проверке это может вызвать вопросы.
3. **После одобрения** в SignPath:
   - проект с доверенной системой сборки GitHub (Trusted Build System → GitHub.com);
   - конфигурация артефакта: Authenticode-подпись файла `*.exe` из артефакта;
   - политика подписи (обычно `release-signing`).
4. **В репозитории GitHub** (Settings → Secrets and variables → Actions):
   - секрет `SIGNPATH_API_TOKEN`: токен пользователя CI из SignPath;
   - переменные `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`.

## Что произойдёт в CI

На Windows после `npm run dist`:

1. неподписанный установщик загружается артефактом `nexus-unsigned`;
2. `signpath/github-action-submit-signing-request@v1` отправляет его на подпись и ждёт результата;
3. подписанный `.exe` заменяет неподписанный, `scripts/rehash-latest.cjs` записывает в `latest.yml` его новые SHA-512 и размер, а `.blockmap` удаляется (он описывает неподписанные байты, и без него обновление скачивается целиком).

Для пулл-реквестов подпись не запускается: им GitHub секреты не даёт.

## Что останется после первой подписанной сборки

- В `package.json` в `build.win.signtoolOptions.publisherName` указать имя из сертификата SignPath (поле «Кому выдан», например `SignPath Foundation`). Пока там `Nexus`: сертификата с таким именем не существует.
- В `src/main/updater.cjs` вернуть Windows автоматические обновления (`this.manual` только для macOS).
- Версии до этой сборки, как и сейчас, обновятся кнопкой «Скачать и установить» один раз.
