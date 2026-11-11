// Nexus window, part 5 of 6: Clicks, changes, forms and the search field.
// The parts are classic scripts loaded in order by index.html and share one
// global scope (see eslint.config.cjs); app-boot.js starts the window.

// What a click on a button does. A button is found by its data attributes first
// (CLICK_BY_DATA, in order: the first test that passes wins), then by its
// data-sg-act or id (CLICK_BY_ID). app-social.js has its own listener for the
// buttons of the profile pages.
const CLICK_BY_DATA = [
  [
    el => el.dataset.unwatch,
    async el => {
      state = await call('removeWatch', el.dataset.unwatch);
      render();
    },
  ],
  [
    el => el.dataset.page,
    async el => {
      return setPage(el.dataset.page);
    },
  ],
  [
    el => el.dataset.filter,
    async el => {
      page = 'library';
      filter = el.dataset.filter;
      render();
    },
  ],
  [
    el => el.dataset.libraryView,
    async el => {
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
    },
  ],
  [
    el => el.dataset.friend,
    async el => {
      showFriend(el.dataset.friend);
    },
  ],
  [
    el => el.dataset.installCancel !== undefined,
    async el => {
      installDlg = null;
      renderInstallDialog();
    },
  ],
  [
    el => el.dataset.installRoot !== undefined && installDlg?.opts,
    async el => {
      const r = await call('chooseInstallRoot', installDlg.root);
      if (r) Object.assign(installDlg, r);
      renderInstallDialog();
    },
  ],
  [
    el => el.dataset.installClient !== undefined && installDlg,
    async el => {
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
    },
  ],
  [
    el => el.dataset.installStart !== undefined && installDlg?.opts,
    async el => {
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
    },
  ],
  [
    el => el.dataset.installImport !== undefined && installDlg,
    async el => {
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
    },
  ],
  [
    el => el.dataset.openFolder,
    async el => {
      await call('openGameFolder', el.dataset.openFolder);
    },
  ],
  [
    el => el.dataset.moveGame,
    async el => {
      el.disabled = true;
      const r = await call('moveGame', el.dataset.moveGame);
      state = r.state;
      storageState.data = null;
      render();
      if (r.result.how === 'moving') toast(`Переносим игру в ${r.result.to}…`);
    },
  ],
  [
    el => el.id === 'storage-refresh',
    async el => {
      storageState.data = null;
      render();
    },
  ],
  [
    el => el.id === 'library-move',
    async el => {
      el.disabled = true;
      const r = await call('moveGame', librarySelection);
      state = r.state;
      render();
      if (r.result.how === 'moving') toast(`Переносим игру в ${r.result.to}…`);
    },
  ],
  [
    el => el.dataset.dlcInstall,
    async el => {
      el.disabled = true;
      const r = await call('installDlc', { id: librarySelection, appId: el.dataset.dlcInstall });
      state = r.state;
      ownedDlcState.delete(librarySelection);
      render();
      toast('Дополнение добавлено в загрузки.');
    },
  ],
  [
    el => el.dataset.downloadAction,
    async el => {
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
    },
  ],
  [
    el => el.dataset.clientDownloads,
    async el => {
      await call('openClientDownloads', el.dataset.clientDownloads);
    },
  ],
  [
    el => el.dataset.listStore,
    async el => {
      listStore = el.dataset.listStore;
      listPreviewId = null;
      render();
      requestBrowse(storeList);
    },
  ],
  [
    el => el.dataset.storeList,
    async el => {
      storeList = el.dataset.storeList;
      listPreviewId = null;
      render();
      requestBrowse(storeList);
      document.querySelector('.store-lists')?.scrollIntoView({ block: 'nearest' });
    },
  ],
  [
    el => el.hasAttribute('data-library-back'),
    async el => {
      librarySelection = null;
      render();
    },
  ],
  [
    el => el.dataset.libraryProvider,
    async el => {
      libraryProvider = el.dataset.libraryProvider;
      if (api && !demo) state = await call('preferred', { id: librarySelection, provider: libraryProvider });
      else state.settings.preferred[librarySelection] = libraryProvider;
      render();
    },
  ],
  [
    el => el.dataset.storePlatform,
    async el => {
      storeProvider = el.dataset.storePlatform;
      featuredIndex = 0;
      render();
    },
  ],
  [
    el => el.dataset.featureStep,
    async el => {
      const count = Math.max(1, featuredItems().length);
      featuredIndex = (featuredIndex + Number(el.dataset.featureStep) + count) % count;
      updateShowcase();
    },
  ],
  [
    el => el.dataset.featureIndex !== undefined,
    async el => {
      featuredIndex = Number(el.dataset.featureIndex);
      updateShowcase();
    },
  ],
  [
    el => el.dataset.storeTag !== undefined,
    async el => {
      storeTag = storeTag === el.dataset.storeTag ? null : el.dataset.storeTag;
      render();
      $('#store-catalog')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  ],
  [
    el => el.dataset.storeTagClear !== undefined,
    async el => {
      storeTag = null;
      render();
    },
  ],
  [
    el => el.dataset.listFilter,
    async el => {
      filter = el.dataset.listFilter;
      libraryLimit = LIBRARY_PAGE;
      render();
    },
  ],
  [
    el => el.dataset.detail,
    async el => {
      return showDetail(el.dataset.detail, !!el.closest('#library-tree'));
    },
  ],
  [
    el => el.dataset.wish,
    async el => {
      return toggleWish(el.dataset.wish);
    },
  ],
  [
    el => el.dataset.epicStoreSignin,
    async el => {
      await call('epicStoreSignIn', el.dataset.epicStoreSignin);
    },
  ],
  [
    el => el.dataset.wishFilter,
    async el => {
      wishFilter = el.dataset.wishFilter;
      render();
    },
  ],
  [
    el => el.dataset.dealsProvider,
    async el => {
      dealsProvider = el.dataset.dealsProvider;
      render();
    },
  ],
  [
    el => el.dataset.login || el.dataset.loginAdd,
    async el => {
      const provider = el.dataset.login || el.dataset.loginAdd;
      await call('login', { provider, add: !!el.dataset.loginAdd });
      toast('Вход выполняется на официальной странице магазина.');
    },
  ],
  [
    el => el.dataset.claim,
    async el => {
      const r = await call('claimFree', {
        appId: el.dataset.claim,
        account: $('#claim-account')?.value || undefined,
      });
      toast(
        `Открыта страница раздачи в Epic Games${r?.account ? ' · аккаунт ' + r.account : ''}. Нажмите «Получить» и подтвердите заказ.`
      );
    },
  ],
  [
    el => el.dataset.collection !== undefined,
    async el => {
      collectionFilter = el.dataset.collection || null;
      page = 'library';
      librarySelection = null;
      libraryLimit = LIBRARY_PAGE;
      render();
    },
  ],
  [
    el => el.dataset.deleteCollection,
    async el => {
      state = await call('deleteCollection', el.dataset.deleteCollection);
      collectionFilter = null;
      render();
      toast('Коллекция удалена. Игры остались в библиотеке.');
    },
  ],
  [
    el => el.dataset.uninstall,
    async el => {
      const r = await call('uninstallGame', {
        id: el.dataset.gameId || librarySelection,
        provider: el.dataset.uninstall,
      });
      storageState.data = null;
      state = r.state;
      render();
      const res = r.result;
      if (res.how === 'started') toast('Удаление началось — прогресс на странице «Загрузки».');
      else if (res.how === 'running') toast('Игра уже удаляется — прогресс на странице «Загрузки».');
      else if (res.how === 'client')
        toast(
          res.result?.how === 'canceled'
            ? 'Действие отменено.'
            : res.result?.viaLibrary
              ? 'Открыта библиотека Epic Games: удалите игру там.'
              : 'Запрос на удаление передан клиенту — подтвердите его там.'
        );
    },
  ],
  [
    el => el.dataset.clientAction,
    async el => {
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
    },
  ],
  [
    el => el.dataset.fullHistory,
    async el => {
      const list = await call('watchHistory', el.dataset.fullHistory);
      const box = el.closest('details')?.querySelector('ul');
      if (box)
        box.innerHTML = list
          .slice()
          .reverse()
          .map(h => `<li>${new Date(h.at).toLocaleString('ru-RU')} · ${esc(money(h))}</li>`)
          .join('');
      el.remove();
    },
  ],
  [
    el => el.dataset.linkA,
    async el => {
      state = await call('linkGames', { a: el.dataset.linkA, b: el.dataset.linkB });
      render();
      toast('Игры объединены');
    },
  ],
  [
    el => el.dataset.split,
    async el => {
      state = await call('splitGame', el.dataset.split);
      librarySelection = null;
      render();
      toast('Игра разделена по магазинам');
    },
  ],
  [
    el => el.dataset.saveKey || el.dataset.clearKey,
    async el => {
      const name = el.dataset.saveKey || el.dataset.clearKey;
      const input = document.querySelector(`[data-key-input="${name}"]`);
      const value = el.dataset.clearKey ? '' : input?.value.trim() || '';
      if (el.dataset.saveKey && !value) throw Error('Введите ключ');
      state = await call('setKey', { name, value });
      render();
      toast(value ? 'Ключ сохранён' : 'Ключ удалён');
    },
  ],
  [
    el => el.dataset.browser,
    async el => {
      await call('browser', el.dataset.browser);
      toast(
        el.dataset.browser === 'epic'
          ? 'Войдите в браузере, затем скопируйте authorizationCode со страницы и вставьте его в поле «Код из браузера».'
          : 'Открыт системный браузер. Его сессия хранится отдельно от Nexus.'
      );
    },
  ],
  [
    el => el.dataset.forget,
    async el => {
      state = await call('forget', el.dataset.forget);
      render();
      toast('Сессия Nexus удалена. Официальный клиент остаётся в своём аккаунте.');
    },
  ],
  [
    el => el.dataset.buy,
    async el => {
      return buy(el.dataset.buy);
    },
  ],
  [
    el => el.dataset.sgMore !== undefined,
    async el => {
      gameAboutOpen = true;
      renderDetail();
    },
  ],
  [
    el => el.dataset.sgOs,
    async el => {
      gameReqOs = el.dataset.sgOs;
      renderDetail();
    },
  ],
  [
    el => el.dataset.gameShot !== undefined,
    async el => {
      gameShot = Number(el.dataset.gameShot) || 0;
      renderDetail();
    },
  ],
];
// No prototype: an id such as "constructor" finds nothing.
const CLICK_BY_ID = Object.create(null);
CLICK_BY_ID['library-store'] = async el => {
  const id = librarySelection;
  await setPage('store');
  showDetail(id);
};
CLICK_BY_ID['library-play'] = async el => {
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
};
CLICK_BY_ID['epic-sync'] = async el => {
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
};
CLICK_BY_ID['library-hide'] = async el => {
  const g = activeGames().find(x => x.id === librarySelection);
  state = await call('setHidden', { id: librarySelection, hidden: !g?.hidden });
  toast(
    g?.hidden ? 'Игра снова видна в библиотеке' : 'Игра скрыта. Её можно показать флажком «Показать скрытые».'
  );
  if (!g?.hidden && !showHidden) librarySelection = null;
  render();
};
CLICK_BY_ID['import-collections'] = async el => {
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
};
CLICK_BY_ID['export-backup'] = async el => {
  const r = await call('exportBackup');
  if (r) toast('Резервная копия сохранена: ' + r.file);
};
CLICK_BY_ID['import-backup'] = async el => {
  const r = await call('importBackup');
  if (r?.result) {
    state = r.state;
    render();
    toast('Настройки восстановлены');
  }
};
CLICK_BY_ID['save-diagnostics'] = async el => {
  const r = await call('saveDiagnostics');
  if (r) toast('Диагностика сохранена: ' + r.file + '. Токены и ключи в ней скрыты.');
};
CLICK_BY_ID['open-logs'] = async el => {
  await call('openLogs');
};
CLICK_BY_ID['library-favorite'] = async el => {
  await toggle('favorites', librarySelection);
};
CLICK_BY_ID['library-wish'] = async el => {
  await toggleWish(librarySelection);
};
CLICK_BY_ID['sync-libraries'] = async el => {
  el.disabled = true;
  try {
    state = await call('syncLibraries');
    render();
  } finally {
    el.disabled = false;
  }
};
CLICK_BY_ID['import-legendary'] = async el => {
  el.disabled = true;
  try {
    state = await call('importLegendary');
    render();
    toast('Список Epic импортирован для подключённого аккаунта.');
  } finally {
    el.disabled = false;
  }
};
CLICK_BY_ID['library-more'] = async el => {
  libraryLimit += LIBRARY_PAGE;
  render();
};
// «↻ Синхронизировать» in «Желаемое» and in «Аккаунтах».
async function syncWishlists(el) {
  el.disabled = true;
  try {
    const r = await call('syncWishlists');
    state = r.state;
    render();
    const { steam, epic, removed, errors } = r.report;
    toast(
      `Желаемое синхронизировано: новых из Steam ${steam}, из Epic ${epic}${removed ? `, убрано ${removed}` : ''}${errors.length ? '. ' + errors.join('; ') : ''}`
    );
  } finally {
    el.disabled = false;
  }
}
CLICK_BY_ID['import-wishlists'] = syncWishlists;
CLICK_BY_ID['sync-wishlists'] = syncWishlists;
CLICK_BY_ID['deals-more'] = async el => {
  await requestSaleList(true);
};
CLICK_BY_ID['check-update'] = async el => {
  state = await call('checkUpdate');
  render();
};
CLICK_BY_ID['install-update'] = async el => {
  await call('installUpdate');
};
CLICK_BY_ID['open-update'] = async el => {
  await call('downloadUpdate');
};
CLICK_BY_ID['show-sales'] = async el => {
  priceFilter.sale = true;
  render();
  document.querySelector('.price-controls')?.scrollIntoView({ behavior: 'smooth' });
};
CLICK_BY_ID['refresh-home'] = async el => {
  await requestHome(true);
};
CLICK_BY_ID['refresh-detail-price'] = async el => {
  el.disabled = true;
  await refreshDetailPrice(true);
};
CLICK_BY_ID['watch-price'] = async el => {
  state = await call('watchPrice', { id: detailId, provider: selectedProvider });
  toast('Отслеживание включено. Цены будут проверяться каждый час, пока Nexus открыт.');
};
CLICK_BY_ID['open-tracking'] = async el => {
  await setPage('tracking');
};
CLICK_BY_ID['check-prices'] = async el => {
  el.disabled = true;
  el.textContent = 'Проверяем…';
  try {
    state = await call('checkPrices');
    render();
  } finally {
    el.disabled = false;
  }
};
CLICK_BY_ID['retry-search'] = async el => {
  await searchCatalog();
};
CLICK_BY_ID['more-results'] = async el => {
  await searchCatalog(true);
};
CLICK_BY_ID['refresh-accounts'] = async el => {
  el.disabled = true;
  try {
    state = await call('refreshAccounts');
    render();
  } finally {
    el.disabled = false;
  }
};
CLICK_BY_ID['refresh-recs'] = async el => {
  return requestRecommendations(true);
};
for (const id of ['library-stop', 'detail-stop'])
  CLICK_BY_ID[id] = async el => {
    el.disabled = true;
    el.textContent = 'Закрываем…';
    const id = el.id === 'library-stop' ? librarySelection : detailId;
    const r = await call('closeGame', id);
    state = r.state || state;
    if (r.result === 'kept') toast('Игра продолжает работать.');
    render();
    renderDetail();
    return;
  };
CLICK_BY_ID['friends-toggle'] = async el => {
  return call('openFriendsWindow');
};
CLICK_BY_ID['check-game-updates'] = async el => {
  el.disabled = true;
  const r = await call('checkUpdates');
  state = r.state;
  render();
  const n = Object.keys(r.result || {}).length;
  toast(
    n ? `Обновления есть у ${n} ${plural(n, 'игры', 'игр', 'игр')}` : 'Все установленные игры Epic обновлены'
  );
  return;
};
for (const id of ['nav-back', 'nav-forward'])
  CLICK_BY_ID[id] = async el => {
    return goHistory(el.id === 'nav-back' ? -1 : 1);
  };
for (const id of ['scan', 'empty-scan'])
  CLICK_BY_ID[id] = async el => {
    el.disabled = true;
    try {
      state = await call('scan');
      demo = false;
      render();
      toast(`Найдено игр: ${state.games.length}`);
    } finally {
      el.disabled = false;
    }
  };
for (const id of ['add-game', 'footer-add'])
  CLICK_BY_ID[id] = async el => {
    state = await call('add');
    demo = false;
    page = 'library';
    render();
  };
CLICK_BY_ID['demo'] = async el => {
  demo = true;
  page = 'library';
  filter = 'all';
  query = '';
  $('#search').value = '';
  render();
};
CLICK_BY_ID['exit-demo'] = async el => {
  demo = false;
  if (api) state = await call('state');
  render();
};
CLICK_BY_ID['steam-root'] = async el => {
  state = await call('steamRoot');
  render();
};
CLICK_BY_ID['buy-selected'] = async el => {
  await buy(selectedProvider);
};
CLICK_BY_ID['detail-wish'] = async el => {
  await toggleWish(detailId);
  renderDetail();
};
CLICK_BY_ID['favorite'] = async el => {
  await toggle('favorites', detailId);
  renderDetail();
};
CLICK_BY_ID['play'] = async el => {
  if (wantsInstallWindow(game(detailId), selectedProvider)) {
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
};
document.addEventListener('click', event =>
  run(async () => {
    const el = event.target.closest('button');
    if (!el || el.disabled) return;
    for (const [test, act] of CLICK_BY_DATA) if (test(el)) return act(el);
    if (el.dataset.sgProvider) selectedProvider = el.dataset.sgProvider;
    return CLICK_BY_ID[el.dataset.sgAct || el.id]?.(el);
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
    if (el.id === 'wish-sort') {
      wishSort = el.value;
      render();
      return;
    }
    if (el.id === 'deals-sort') {
      dealsSort = el.value;
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
    if (el.id === 'notify-wish-sales') state = await call('notifyWishSales', el.checked);
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
  if (page === 'game' && query.trim()) page = 'store';
  if (page === 'store') {
    searchState = { items: [], providers: {}, loading: !!query.trim(), query: query.trim(), start: 0 };
    render();
    if (query.trim()) searchTimer = setTimeout(() => searchCatalog(), 450);
  } else render();
});
