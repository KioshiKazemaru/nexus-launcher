// Nexus window, part 4 of 5: Clicks, changes, forms and the search field.
// The parts are classic scripts loaded in order by index.html and share one
// global scope (see eslint.config.cjs); app-boot.js starts the window.
document.addEventListener('click', event =>
  run(async () => {
    const el = event.target.closest('button');
    if (!el || el.disabled) return;
    if (el.dataset.unwatch) {
      state = await call('removeWatch', el.dataset.unwatch);
      render();
      return;
    }
    if (el.dataset.page) return setPage(el.dataset.page);
    if (el.dataset.filter) {
      page = 'library';
      filter = el.dataset.filter;
      render();
      return;
    }
    if (el.dataset.libraryView) {
      state = api
        ? await call('libraryView', el.dataset.libraryView)
        : { ...state, settings: { ...state.settings, libraryView: el.dataset.libraryView } };
      filter = 'all';
      render();
      if (
        el.dataset.libraryView === 'owned' &&
        api &&
        ['steam', 'epic'].some(
          p =>
            state.accounts[p]?.status === 'connected' &&
            !['loading', 'ready'].includes(state.libraryState?.[p]?.status)
        )
      )
        call('syncLibraries')
          .then(next => {
            state = next;
            render();
          })
          .catch(e => toast(e.message));
      return;
    }
    if (el.dataset.friend) {
      await call('openProfile', { provider: 'steam', id: el.dataset.friend });
      return;
    }
    if (el.dataset.installCancel !== undefined) {
      installDlg = null;
      renderInstallDialog();
      return;
    }
    if (el.dataset.installRoot !== undefined && installDlg?.opts) {
      const r = await call('chooseInstallRoot', installDlg.root);
      if (r) Object.assign(installDlg, r);
      renderInstallDialog();
      return;
    }
    if (el.dataset.installClient !== undefined && installDlg) {
      const gid = installDlg.id;
      installDlg = null;
      renderInstallDialog();
      const r = await call('clientAction', { id: gid, provider: 'epic', action: 'install' });
      state = r.state;
      render();
      toast(
        r.result.viaLibrary
          ? 'Открыта библиотека Epic Games: выберите игру там.'
          : 'Установка передана Epic Games Launcher.'
      );
      return;
    }
    if (el.dataset.installStart !== undefined && installDlg?.opts) {
      const x = installDlg;
      x.busy = true;
      renderInstallDialog();
      try {
        const r = await call('startInstall', {
          id: x.id,
          root: x.root,
          tags: x.opts.components.length ? [...x.tags] : null,
          dlcs: [...x.dlcs],
        });
        state = r.state;
        installDlg = null;
        renderInstallDialog();
        render();
        toast('Загрузка началась — прогресс на странице «Загрузки».');
      } catch (e) {
        x.busy = false;
        x.error = '';
        renderInstallDialog();
        throw e;
      }
      return;
    }
    if (el.dataset.installImport !== undefined && installDlg) {
      const gid = installDlg.id;
      const r = await call('importGame', gid);
      if (r.result.how === 'canceled') return;
      installDlg = null;
      renderInstallDialog();
      state = r.state;
      render();
      toast(
        r.result.missing
          ? `Игра найдена. Не хватает или повреждено файлов: ${r.result.missing} — Nexus докачает их.`
          : 'Игра найдена и добавлена — можно играть.'
      );
      return;
    }
    if (el.dataset.openFolder) {
      await call('openGameFolder', el.dataset.openFolder);
      return;
    }
    if (el.dataset.moveGame) {
      el.disabled = true;
      const r = await call('moveGame', el.dataset.moveGame);
      state = r.state;
      storageState.data = null;
      render();
      if (r.result.how === 'moving') toast(`Переносим игру в ${r.result.to}…`);
      return;
    }
    if (el.id === 'storage-refresh') {
      storageState.data = null;
      render();
      return;
    }
    if (el.id === 'library-move') {
      el.disabled = true;
      const r = await call('moveGame', librarySelection);
      state = r.state;
      render();
      if (r.result.how === 'moving') toast(`Переносим игру в ${r.result.to}…`);
      return;
    }
    if (el.dataset.dlcInstall) {
      el.disabled = true;
      const r = await call('installDlc', { id: librarySelection, appId: el.dataset.dlcInstall });
      state = r.state;
      ownedDlcState.delete(librarySelection);
      render();
      toast('Дополнение добавлено в загрузки.');
      return;
    }
    if (el.dataset.downloadAction) {
      el.disabled = true;
      const action = el.dataset.downloadAction;
      const r = await call('downloadControl', { id: el.dataset.downloadId || librarySelection, action });
      state = r.state;
      render();
      if (action === 'update' || action === 'repair')
        toast(
          action === 'update'
            ? 'Обновление началось — прогресс на странице «Загрузки».'
            : 'Проверяем файлы игры…'
        );
      return;
    }
    if (el.dataset.clientDownloads) {
      await call('openClientDownloads', el.dataset.clientDownloads);
      return;
    }
    if (el.dataset.listStore) {
      listStore = el.dataset.listStore;
      listPreviewId = null;
      render();
      requestBrowse(storeList);
      return;
    }
    if (el.dataset.storeList) {
      storeList = el.dataset.storeList;
      listPreviewId = null;
      render();
      requestBrowse(storeList);
      document.querySelector('.store-lists')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (el.hasAttribute('data-library-back')) {
      librarySelection = null;
      render();
      return;
    }
    if (el.dataset.libraryProvider) {
      libraryProvider = el.dataset.libraryProvider;
      if (api && !demo) state = await call('preferred', { id: librarySelection, provider: libraryProvider });
      else state.settings.preferred[librarySelection] = libraryProvider;
      render();
      return;
    }
    if (el.dataset.storePlatform) {
      storeProvider = el.dataset.storePlatform;
      featuredIndex = 0;
      render();
      return;
    }
    if (el.dataset.featureStep) {
      const count = Math.max(1, featuredItems().length);
      featuredIndex = (featuredIndex + Number(el.dataset.featureStep) + count) % count;
      updateShowcase();
      return;
    }
    if (el.dataset.featureIndex !== undefined) {
      featuredIndex = Number(el.dataset.featureIndex);
      updateShowcase();
      return;
    }
    if (el.dataset.storeTag !== undefined) {
      storeTag = storeTag === el.dataset.storeTag ? null : el.dataset.storeTag;
      render();
      $('#store-catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (el.dataset.storeTagClear !== undefined) {
      storeTag = null;
      render();
      return;
    }
    if (el.dataset.listFilter) {
      filter = el.dataset.listFilter;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.dataset.detail) return showDetail(el.dataset.detail);
    if (el.dataset.wish) return toggle('wishlist', el.dataset.wish);
    if (el.dataset.login || el.dataset.loginAdd) {
      const provider = el.dataset.login || el.dataset.loginAdd;
      await call('login', { provider, add: !!el.dataset.loginAdd });
      toast('Вход выполняется на официальной странице магазина.');
      return;
    }
    if (el.dataset.claim) {
      const r = await call('claimFree', {
        appId: el.dataset.claim,
        account: $('#claim-account')?.value || undefined,
      });
      toast(
        `Открыта страница раздачи в Epic Games${r?.account ? ' · аккаунт ' + r.account : ''}. Нажмите «Получить» и подтвердите заказ.`
      );
      return;
    }
    if (el.dataset.collection !== undefined) {
      collectionFilter = el.dataset.collection || null;
      page = 'library';
      librarySelection = null;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.dataset.deleteCollection) {
      state = await call('deleteCollection', el.dataset.deleteCollection);
      collectionFilter = null;
      render();
      toast('Коллекция удалена. Игры остались в библиотеке.');
      return;
    }
    if (el.dataset.uninstall) {
      el.disabled = true;
      const r = await call('uninstallGame', {
        id: el.dataset.gameId || librarySelection,
        provider: el.dataset.uninstall,
      });
      storageState.data = null;
      state = r.state;
      render();
      const res = r.result;
      if (res.how === 'started') toast('Удаление началось — прогресс на странице «Загрузки».');
      else if (res.how === 'client')
        toast(
          res.result?.how === 'canceled'
            ? 'Действие отменено.'
            : res.result?.viaLibrary
              ? 'Открыта библиотека Epic Games: удалите игру там.'
              : 'Запрос на удаление передан клиенту — подтвердите его там.'
        );
      return;
    }
    if (el.dataset.clientAction) {
      const g = activeGames().find(x => x.id === librarySelection);
      const provider = selectedLibraryOffer(g)?.provider;
      const r = await call('clientAction', {
        id: librarySelection,
        provider,
        action: el.dataset.clientAction,
      });
      state = r.state;
      render();
      toast(
        r.result.how === 'client-install'
          ? 'Устанавливаем лаунчер. После входа в аккаунт игра откроется в нём.'
          : r.result.how === 'canceled'
            ? 'Действие отменено.'
            : r.result.viaLibrary
              ? 'Открыта библиотека Epic Games: выберите игру там.'
              : {
                  verify: 'Проверка файлов запущена в клиенте.',
                  uninstall: 'Запрос на удаление передан клиенту — подтвердите его там.',
                  install: 'Установка передана клиенту.',
                }[el.dataset.clientAction]
      );
      return;
    }
    if (el.dataset.fullHistory) {
      const list = await call('watchHistory', el.dataset.fullHistory);
      const box = el.closest('details')?.querySelector('ul');
      if (box)
        box.innerHTML = list
          .slice()
          .reverse()
          .map(h => `<li>${new Date(h.at).toLocaleString('ru-RU')} · ${esc(money(h))}</li>`)
          .join('');
      el.remove();
      return;
    }
    if (el.dataset.linkA) {
      state = await call('linkGames', { a: el.dataset.linkA, b: el.dataset.linkB });
      render();
      toast('Игры объединены');
      return;
    }
    if (el.dataset.split) {
      state = await call('splitGame', el.dataset.split);
      librarySelection = null;
      render();
      toast('Игра разделена по магазинам');
      return;
    }
    if (el.dataset.saveKey || el.dataset.clearKey) {
      const name = el.dataset.saveKey || el.dataset.clearKey;
      const input = document.querySelector(`[data-key-input="${name}"]`);
      const value = el.dataset.clearKey ? '' : input?.value.trim() || '';
      if (el.dataset.saveKey && !value) throw Error('Введите ключ');
      state = await call('setKey', { name, value });
      render();
      toast(value ? 'Ключ сохранён' : 'Ключ удалён');
      return;
    }
    if (el.dataset.browser) {
      await call('browser', el.dataset.browser);
      toast(
        el.dataset.browser === 'epic'
          ? 'Войдите в браузере, затем скопируйте authorizationCode со страницы и вставьте его в поле «Код из браузера».'
          : 'Открыт системный браузер. Его сессия хранится отдельно от Nexus.'
      );
      return;
    }
    if (el.dataset.forget) {
      state = await call('forget', el.dataset.forget);
      render();
      toast('Сессия Nexus удалена. Официальный клиент остаётся в своём аккаунте.');
      return;
    }
    if (el.dataset.buy) return buy(el.dataset.buy);

    if (el.classList.contains('close')) {
      $('#details').close();
      detailId = null;
      return;
    }
    switch (el.id) {
      case 'library-store': {
        const id = librarySelection;
        await setPage('store');
        showDetail(id);
        break;
      }
      case 'library-play':
        {
          const lg = activeGames().find(g => g.id === librarySelection);
          if (wantsInstallWindow(lg, selectedLibraryOffer(lg)?.provider))
            return openInstallDialog(librarySelection);
        }
        el.disabled = true;
        try {
          const r = await call('play', {
            id: librarySelection,
            provider: selectedLibraryOffer(activeGames().find(g => g.id === librarySelection))?.provider,
          });
          state = r.state || r;
          toast(playToast(r.result));
        } finally {
          render();
        }
        break;
      case 'epic-sync': {
        el.disabled = true;
        try {
          const r = await call('epicSyncSaves', librarySelection);
          state = r.state;
          toast(
            r.result?.supported
              ? 'Сохранения синхронизированы с облаком Epic.'
              : 'Эта игра не использует облачные сохранения Epic.'
          );
        } finally {
          el.disabled = false;
        }
        break;
      }
      case 'library-hide': {
        const g = activeGames().find(x => x.id === librarySelection);
        state = await call('setHidden', { id: librarySelection, hidden: !g?.hidden });
        toast(
          g?.hidden
            ? 'Игра снова видна в библиотеке'
            : 'Игра скрыта. Её можно показать флажком «Показать скрытые».'
        );
        if (!g?.hidden && !showHidden) librarySelection = null;
        render();
        break;
      }
      case 'import-collections': {
        el.disabled = true;
        try {
          const r = await call('importSteamCollections');
          state = r.state;
          render();
          toast(
            `Коллекций: ${r.report.collections}, скрытых: +${r.report.hidden}, избранных: +${r.report.favorites}${r.report.errors.length ? '. ' + r.report.errors.join('; ') : ''}`
          );
        } finally {
          el.disabled = false;
        }
        break;
      }
      case 'export-backup': {
        const r = await call('exportBackup');
        if (r) toast('Резервная копия сохранена: ' + r.file);
        break;
      }
      case 'import-backup': {
        const r = await call('importBackup');
        if (r?.result) {
          state = r.state;
          render();
          toast('Настройки восстановлены');
        }
        break;
      }
      case 'save-diagnostics': {
        const r = await call('saveDiagnostics');
        if (r) toast('Диагностика сохранена: ' + r.file + '. Токены и ключи в ней скрыты.');
        break;
      }
      case 'open-logs':
        await call('openLogs');
        break;
      case 'library-favorite':
        await toggle('favorites', librarySelection);
        break;
      case 'library-wish':
        await toggle('wishlist', librarySelection);
        break;
      case 'sync-libraries':
        el.disabled = true;
        try {
          state = await call('syncLibraries');
          render();
        } finally {
          el.disabled = false;
        }
        break;
      case 'import-legendary':
        el.disabled = true;
        try {
          state = await call('importLegendary');
          render();
          toast('Список Epic импортирован для подключённого аккаунта.');
        } finally {
          el.disabled = false;
        }
        break;
      case 'library-more':
        libraryLimit += LIBRARY_PAGE;
        render();
        break;
      case 'import-wishlists': {
        el.disabled = true;
        try {
          const r = await call('importWishlists');
          state = r.state;
          render();
          toast(
            `Добавлено в желаемое: Steam ${r.report.steam}, Epic ${r.report.epic}${r.report.errors.length ? '. ' + r.report.errors.join('; ') : ''}`
          );
        } finally {
          el.disabled = false;
        }
        break;
      }
      case 'check-update':
        state = await call('checkUpdate');
        render();
        break;
      case 'install-update':
        await call('installUpdate');
        break;
      case 'show-sales':
        priceFilter.sale = true;
        render();
        document.querySelector('.price-controls')?.scrollIntoView({ behavior: 'smooth' });
        break;
      case 'refresh-home':
        await requestHome(true);
        break;
      case 'refresh-detail-price':
        el.disabled = true;
        await refreshDetailPrice(true);
        break;
      case 'watch-price':
        state = await call('watchPrice', { id: detailId, provider: selectedProvider });
        toast('Отслеживание включено. Цены будут проверяться каждый час, пока Nexus открыт.');
        break;
      case 'open-tracking':
        $('#details').close();
        detailId = null;
        await setPage('tracking');
        break;
      case 'check-prices':
        el.disabled = true;
        el.textContent = 'Проверяем…';
        try {
          state = await call('checkPrices');
          render();
        } finally {
          el.disabled = false;
        }
        break;
      case 'retry-search':
        await searchCatalog();
        break;
      case 'more-results':
        await searchCatalog(true);
        break;
      case 'refresh-accounts':
        el.disabled = true;
        try {
          state = await call('refreshAccounts');
          render();
        } finally {
          el.disabled = false;
        }
        break;
      case 'refresh-recs':
        return requestRecommendations(true);
      case 'library-stop':
      case 'detail-stop': {
        el.disabled = true;
        el.textContent = 'Закрываем…';
        const id = el.id === 'library-stop' ? librarySelection : detailId;
        const r = await call('closeGame', id);
        state = r.state || state;
        if (r.result === 'kept') toast('Игра продолжает работать.');
        render();
        if ($('#details').open) renderDetail();
        return;
      }
      case 'friends-toggle':
        return call('openFriendsWindow');
      case 'check-game-updates': {
        el.disabled = true;
        const r = await call('checkUpdates');
        state = r.state;
        render();
        const n = Object.keys(r.result || {}).length;
        toast(
          n
            ? `Обновления есть у ${n} ${plural(n, 'игры', 'игр', 'игр')}`
            : 'Все установленные игры Epic обновлены'
        );
        return;
      }
      case 'nav-back':
      case 'nav-forward':
        return goHistory(el.id === 'nav-back' ? -1 : 1);
      case 'scan':
      case 'empty-scan':
        el.disabled = true;
        try {
          state = await call('scan');
          demo = false;
          render();
          toast(`Найдено игр: ${state.games.length}`);
        } finally {
          el.disabled = false;
        }
        break;
      case 'add-game':
      case 'footer-add':
        state = await call('add');
        demo = false;
        page = 'library';
        render();
        break;
      case 'demo':
        demo = true;
        page = 'library';
        filter = 'all';
        query = '';
        $('#search').value = '';
        render();
        break;
      case 'exit-demo':
        demo = false;
        if (api) state = await call('state');
        render();
        break;
      case 'steam-root':
        state = await call('steamRoot');
        render();
        break;
      case 'buy-selected':
        await buy(selectedProvider);
        break;
      case 'detail-wish':
        await toggle('wishlist', detailId);
        renderDetail();
        break;
      case 'favorite':
        await toggle('favorites', detailId);
        renderDetail();
        break;
      case 'play':
        if (wantsInstallWindow(game(detailId), selectedProvider)) {
          $('#details').close();
          return openInstallDialog(detailId);
        }
        el.disabled = true;
        try {
          const r = await call('play', { id: detailId, provider: selectedProvider });
          state = r.state || r;
          render();
          toast(playToast(r.result));
        } finally {
          renderDetail();
        }
        break;
    }
  })
);
document.addEventListener('change', event =>
  run(async () => {
    const el = event.target;
    if (el.dataset.target) {
      const value = el.value.trim();
      if (!el.checkValidity()) throw Error('Введите неотрицательную цену');
      state = await call('priceTarget', {
        key: el.dataset.target,
        target: value === '' ? null : Number(value),
      });
      toast('Желаемая цена сохранена');
      return;
    }
    if (['price-min', 'price-max', 'sale-only', 'price-sort'].includes(el.id)) {
      if (!el.checkValidity()) return;
      if (el.id === 'price-min') priceFilter.min = el.value;
      if (el.id === 'price-max') priceFilter.max = el.value;
      if (el.id === 'sale-only') priceFilter.sale = el.checked;
      if (el.id === 'price-sort') priceFilter.sort = el.value;
      render();
      return;
    }
    if (el.id === 'store-currency') {
      detailPrices.clear();
      const c = currencyCountries[el.value];
      state = api ? await call('country', c) : { ...state, settings: { ...state.settings, storeCountry: c } };
      priceFilter.min = '';
      priceFilter.max = '';
      if (query.trim()) await searchCatalog();
      else {
        render();
        requestBrowse(storeList);
      }
      return;
    }
    if (el.id === 'store-country') {
      detailPrices.clear();
      priceFilter.min = '';
      priceFilter.max = '';
      state = api
        ? await call('country', el.value)
        : { ...state, settings: { ...state.settings, storeCountry: el.value } };
      if (query.trim()) await searchCatalog();
      else {
        render();
        requestBrowse(storeList);
      }
      return;
    }
    if (el.dataset.remember) {
      try {
        state = await call('remember', { provider: el.dataset.remember, enabled: el.checked });
        render();
      } catch (e) {
        el.checked = !el.checked;
        throw e;
      }
    }
    if (el.dataset.collectionToggle) {
      state = await call('setInCollection', {
        collection: el.dataset.collectionToggle,
        id: librarySelection,
        include: el.checked,
      });
      render();
      return;
    }
    if (el.id === 'show-hidden') {
      showHidden = el.checked;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.id === 'library-sort') {
      librarySort = el.value;
      libraryLimit = LIBRARY_PAGE;
      render();
      return;
    }
    if (el.id === 'notify-giveaways') state = await call('notifyGiveaways', el.checked);
    if (el.id === 'auto-update') state = await call('autoUpdate', el.checked);
    if (el.dataset.installTag && installDlg?.opts) {
      installDlg.tags[el.checked ? 'add' : 'delete'](el.dataset.installTag);
      renderInstallDialog();
      return;
    }
    if (el.dataset.installDlc && installDlg?.opts) {
      installDlg.dlcs[el.checked ? 'add' : 'delete'](el.dataset.installDlc);
      return;
    }
    if (el.dataset.launchSetting)
      state = await call('launchSetting', { name: el.dataset.launchSetting, value: el.checked });
    if (el.id === 'download-limit') {
      if (!el.checkValidity()) throw Error('Укажите скорость от 0 до 10000 МБ/с');
      state = await call('downloadSettings', { downloadLimit: Math.round(Number(el.value || 0) * 1024) });
      toast(
        Number(el.value) ? `Загрузки Nexus ограничены ${el.value} МБ/с` : 'Скорость загрузок не ограничена'
      );
    }
    if (['schedule-enabled', 'schedule-from', 'schedule-to'].includes(el.id)) {
      state = await call('downloadSettings', {
        schedule: {
          enabled: $('#schedule-enabled').checked,
          from: $('#schedule-from').value,
          to: $('#schedule-to').value,
        },
      });
      render();
    }
    if (el.id === 'epic-auto-update') state = await call('downloadSettings', { epicAutoUpdate: el.checked });
    if (el.id === 'download-notify') state = await call('downloadSettings', { downloadNotify: el.checked });
    if (el.id === 'auto-start') {
      try {
        state = await call('autoStart', el.checked);
      } catch (e) {
        el.checked = !el.checked;
        throw e;
      }
    }
    if (el.name === 'provider') {
      selectedProvider = el.value;
      if (!demo && api) state = await call('preferred', { id: detailId, provider: selectedProvider });
      else state.settings.preferred[detailId] = selectedProvider;
      renderDetail();
    }
  })
);
document.addEventListener('submit', event => {
  if (event.target.id === 'track-process-form') {
    event.preventDefault();
    run(async () => {
      state = await call('setTrackProcess', { id: librarySelection, process: $('#track-process').value });
      render();
      toast('Сохранено');
    });
    return;
  }
  if (event.target.id === 'new-collection-form') {
    event.preventDefault();
    run(async () => {
      const name = $('#new-collection').value.trim();
      if (!name) throw Error('Введите название коллекции');
      state = await call('createCollection', name);
      const c = state.settings.collections.find(x => x.name === name);
      if (c && librarySelection)
        state = await call('setInCollection', { collection: c.id, id: librarySelection, include: true });
      render();
      toast('Коллекция создана');
    });
    return;
  }
  if (event.target.id === 'epic-code-form') {
    event.preventDefault();
    run(async () => {
      const input = $('#epic-code');
      state = await call('epicCode', input.value);
      input.value = '';
      render();
      toast('Аккаунт Epic Games подключён');
    });
    return;
  }
  if (event.target.id !== 'steam-form') return;
  event.preventDefault();
  run(async () => {
    const b = event.target.querySelector('button');
    b.disabled = true;
    b.textContent = 'Загрузка…';
    try {
      state = await call('steamImport', {
        steamId: $('#steam-id').value.trim(),
        key: $('#api-key').value.trim(),
      });
      $('#api-key').value = '';
      render();
      toast('Библиотека Steam импортирована.');
    } finally {
      b.disabled = false;
      b.textContent = 'Импортировать';
    }
  });
});
$('#search').addEventListener('input', e => {
  query = e.target.value;
  clearTimeout(searchTimer);
  searchSequence++;
  if (page === 'store') {
    searchState = { items: [], providers: {}, loading: !!query.trim(), query: query.trim(), start: 0 };
    render();
    if (query.trim()) searchTimer = setTimeout(() => searchCatalog(), 450);
  } else render();
});
