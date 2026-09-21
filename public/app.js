/* Мини-апп CRM. Все данные приходят с сервера — здесь только отображение
   и отправка действий. Словари и ссылки на контакты тоже считает сервер,
   чтобы бот и приложение не разошлись в правилах. */
(function () {
  "use strict";

  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = (tg && tg.initData) || "";

  var dict = null;
  var S = {};           // статус -> описание
  var SRC = {};         // источник -> описание
  var PLAN = [];
  var leads = [];
  var log = [];
  var serverToday = "";
  var CLOSED = { work: 1, no: 1 };

  var tab = "queue";
  var filter = "all";
  var srcFilter = "all";
  var query = "";
  var editing = null;
  var busy = false;
  var loadedAt = 0;

  // Цвет статуса — дело оформления, поэтому живёт здесь, а не в данных.
  var STATUS_CLASS = { sent: "s-sent", chat: "s-chat", call: "s-call", think: "s-think", work: "s-work", no: "s-no" };

  var $ = function (id) { return document.getElementById(id); };

  try { var saved = localStorage.getItem("crm-tab"); if (saved === "work" || saved === "queue") tab = saved; } catch (e) {}

  /* ---------- даты ---------- */
  function mondayOf(iso) {
    var d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  var MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  function human(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00Z");
    if (isNaN(d.getTime())) return "";
    // Год показываем, только когда он не совпадает с текущим.
    var year = String(d.getUTCFullYear()) === serverToday.slice(0, 4) ? "" : " " + d.getUTCFullYear();
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + year;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------- обмен с сервером ---------- */
  function api(path, body) {
    var options = {
      method: body ? "POST" : "GET",
      headers: { "x-init-data": initData },
    };
    if (body) {
      options.headers["content-type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || "Сервер ответил " + res.status);
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function applyState(data) {
    if (data.dict) {
      dict = data.dict;
      S = {}; dict.statuses.forEach(function (s) { S[s.k] = s; });
      SRC = {}; dict.sources.forEach(function (s) { SRC[s.k] = s; });
      PLAN = dict.plan;
      fillSelect($("f-source"), dict.sources);
      fillSelect($("f-status"), dict.statuses);
      fillSelect($("b-source"), dict.sources);
      $("b-source").value = "cold";
    }
    if (data.leads) leads = data.leads;
    if (data.log) log = data.log;
    if (data.today) serverToday = data.today;
    loadedAt = Date.now();
    render();
  }

  /* ---------- отрисовка ---------- */
  function statusPill(k) {
    var s = S[k] || S.new || { t: k };
    return '<span class="pill ' + (STATUS_CLASS[k] || "") + '">' + esc(s.t) + "</span>";
  }

  function whenLabel(l) {
    if (!l.next || CLOSED[l.status]) {
      return l.last ? '<span class="when">контакт ' + human(l.last) + "</span>" : '<span class="when"></span>';
    }
    if (l.next < serverToday) return '<span class="when late">просрочено с ' + human(l.next) + "</span>";
    if (l.next === serverToday) return '<span class="when today">сегодня</span>';
    return '<span class="when">касание ' + human(l.next) + "</span>";
  }

  function contactHtml(l) {
    if (!l.contact) return "";
    return l.url
      ? '<a href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.contact) + "</a>"
      : esc(l.contact);
  }

  function card(l, isDue, isQueue) {
    var src = SRC[l.source];
    var meta = [l.niche ? esc(l.niche) : "", contactHtml(l)].filter(Boolean).join(" · ");
    return '<article class="card' + (isDue ? " due" : "") + '" data-id="' + esc(l.id) + '">' +
      '<div><div class="name">' + esc(l.name || "Без имени") + "</div>" +
      (src ? '<div class="src">' + esc(src.t) + "</div>" : "") + "</div>" +
      statusPill(l.status) +
      (meta ? '<div class="meta">' + meta + "</div>" : "") +
      (isQueue && l.hook ? '<div class="hook">' + esc(l.hook) + "</div>" : "") +
      '<div class="row">' +
      (isQueue ? '<span class="when">' + (l.hook ? "зацепка есть" : "нужен разбор") + "</span>" : whenLabel(l)) +
      (CLOSED[l.status] ? "" : '<button class="btn primary" type="button" data-act="wrote">Написал</button>') +
      '<button class="btn" type="button" data-act="open">Открыть</button></div></article>';
  }

  function renderQueue() {
    var queue = leads.filter(function (l) { return (l.status || "new") === "new"; });
    var bySrc = {};
    queue.forEach(function (l) {
      var k = SRC[l.source] ? l.source : "cold";
      (bySrc[k] = bySrc[k] || []).push(l);
    });

    $("queueN").textContent = queue.length || "";
    $("queueCount").textContent = queue.length ? queue.length + " ждут первого сообщения" : "";
    if (srcFilter !== "all" && !bySrc[srcFilter]) srcFilter = "all";

    $("srcChips").innerHTML = queue.length
      ? ['<button class="chip" type="button" data-sf="all" aria-pressed="' + (srcFilter === "all") + '">Все<span class="n num">' + queue.length + "</span></button>"]
          .concat((dict ? dict.sources : []).filter(function (s) { return bySrc[s.k]; }).map(function (s) {
            return '<button class="chip" type="button" data-sf="' + s.k + '" aria-pressed="' + (srcFilter === s.k) + '">' +
              esc(s.t) + '<span class="n num">' + bySrc[s.k].length + "</span></button>";
          })).join("")
      : "";

    var groups = (dict ? dict.sources : []).filter(function (s) {
      return bySrc[s.k] && (srcFilter === "all" || srcFilter === s.k);
    });

    $("queue").innerHTML = groups.length
      ? groups.map(function (s) {
          // Те, по кому уже есть зацепка, идут первыми — им проще написать.
          var items = bySrc[s.k].slice().sort(function (a, b) {
            return (b.hook ? 1 : 0) - (a.hook ? 1 : 0) || String(a.created || "").localeCompare(String(b.created || ""));
          });
          return '<div class="group"><div class="group-h"><span>' + esc(s.t) + '</span><span class="num">' +
            items.length + '</span></div><div class="list">' +
            items.map(function (l) { return card(l, false, true); }).join("") + "</div></div>";
        }).join("")
      : '<div class="empty">Список пуст. Нажми «Добавить списком» или просто пришли людей боту сообщением — по одному на строку.</div>';
  }

  function render() {
    if (!dict) return;
    $("tab-queue").setAttribute("aria-selected", tab === "queue");
    $("tab-work").setAttribute("aria-selected", tab === "work");
    $("view-queue").hidden = tab !== "queue";
    $("view-work").hidden = tab !== "work";
    // На вкладке очереди свои кнопки добавления — плавающая была бы третьей.
    $("add").hidden = tab === "queue";

    var active = leads.filter(function (l) { return (l.status || "new") !== "new" && !CLOSED[l.status]; }).length;
    $("workN").textContent = active || "";
    renderQueue();

    $("week").textContent = "неделя с " + human(mondayOf(serverToday));

    var counts = { warm: 0, partner: 0, cold: 0, call: 0, prepay: 0 };
    log.forEach(function (e) {
      if (e.kind === "msg" && e.plan && counts[e.plan] != null) counts[e.plan]++;
      if (e.kind === "call") counts.call++;
      if (e.kind === "prepay") counts.prepay++;
    });
    $("plan").innerHTML = PLAN.map(function (p) {
      var v = counts[p.k], pct = Math.min(100, Math.round((v / p.goal) * 100));
      return '<div class="meter' + (v >= p.goal ? " done" : "") + '"><div class="lbl"><span>' + esc(p.t) +
        '</span><b class="num">' + v + " / " + p.goal + '</b></div><div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join("") + '<div class="hint">Правило: +1 когда отправил первое сообщение или дожим. Созвон и предоплата считаются сами, когда меняешь статус.</div>';

    var due = leads.filter(function (l) { return !CLOSED[l.status] && l.next && l.next <= serverToday; })
      .sort(function (a, b) { return a.next < b.next ? -1 : 1; });
    $("dueCount").textContent = due.length ? due.length + " чел." : "";
    $("due").innerHTML = due.length
      ? due.map(function (l) { return card(l, true); }).join("")
      : '<div class="empty">На сегодня касаний нет. Время собрать новых людей в базу и написать первые сообщения.</div>';

    var byStatus = {};
    leads.forEach(function (l) { byStatus[l.status || "new"] = (byStatus[l.status || "new"] || 0) + 1; });
    $("chips").innerHTML = ['<button class="chip" type="button" data-f="all" aria-pressed="' + (filter === "all") + '">Все<span class="n num">' + leads.length + "</span></button>"]
      .concat(dict.statuses.filter(function (s) { return byStatus[s.k]; }).map(function (s) {
        return '<button class="chip" type="button" data-f="' + s.k + '" aria-pressed="' + (filter === s.k) + '">' +
          esc(s.t) + '<span class="n num">' + byStatus[s.k] + "</span></button>";
      })).join("");

    var q = query.trim().toLowerCase();
    var order = {};
    dict.statuses.forEach(function (s, i) { order[s.k] = i; });
    var rows = leads
      .filter(function (l) { return filter === "all" || (l.status || "new") === filter; })
      .filter(function (l) {
        return !q || [l.name, l.niche, l.contact, l.note, l.hook, l.found].join(" ").toLowerCase().indexOf(q) !== -1;
      })
      .sort(function (a, b) {
        return (order[a.status] || 0) - (order[b.status] || 0) || String(b.updated || "").localeCompare(String(a.updated || ""));
      });

    $("allCount").textContent = leads.length ? leads.length + " в базе" : "";
    $("all").innerHTML = rows.length
      ? rows.map(function (l) { return card(l, false); }).join("")
      : (leads.length ? '<div class="empty">Никого с таким фильтром.</div>'
                      : '<div class="empty">База пустая. Собери первых людей списком — писать начнёшь со следующего дня.</div>');
  }

  /* ---------- действия ---------- */
  function haptic(type) {
    try { tg && tg.HapticFeedback && tg.HapticFeedback.notificationOccurred(type); } catch (e) {}
  }

  function toast(msg) {
    var el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function fail(err) {
    haptic("error");
    if (err && (err.status === 401 || err.status === 403)) {
      showGate(err.status === 403 ? "Доступ закрыт" : "Telegram не подтвердил вход", err.message || "");
      return;
    }
    toast((err && err.message) || "Не сохранилось, попробуй ещё раз");
  }

  function confirmAsk(text) {
    return new Promise(function (resolve) {
      if (tg && tg.showConfirm) tg.showConfirm(text, resolve);
      else resolve(window.confirm(text));
    });
  }

  // Кнопка «Написал» двигает счётчик плана, поэтому защищаемся
  // от второго нажатия, пока первый запрос не вернулся.
  function wrote(id, button) {
    if (busy) return;
    busy = true;
    if (button) button.disabled = true;
    api("/api/wrote", { id: id }).then(function (data) {
      applyState(data);
      haptic("success");
      toast("Записал. Следующее касание " + human(data.next));
    }).catch(fail).then(function () {
      busy = false;
      if (button) button.disabled = false;
    });
  }

  function fillSelect(el, items) {
    el.innerHTML = items.map(function (i) { return '<option value="' + i.k + '">' + esc(i.t) + "</option>"; }).join("");
  }

  function openForm(id) {
    editing = id ? leads.filter(function (x) { return x.id === id; })[0] : null;
    var l = editing || { status: "new", source: "cold" };
    $("formTitle").textContent = editing ? "Карточка контакта" : "Новый контакт";
    $("f-name").value = l.name || "";
    $("f-contact").value = l.contact || "";
    $("f-niche").value = l.niche || "";
    $("f-source").value = l.source || "cold";
    $("f-status").value = l.status || "new";
    $("f-hook").value = l.hook || "";
    $("f-found").value = l.found || "";
    $("f-note").value = l.note || "";
    $("f-last").value = l.last || "";
    $("f-next").value = l.next || "";
    $("del").hidden = !editing;
    $("dlg").showModal();
  }

  function saveForm() {
    var name = $("f-name").value.trim();
    if (!name) { $("f-name").focus(); return; }
    if (busy) return;
    busy = true;
    $("save").disabled = true;

    api("/api/lead", {
      id: editing ? editing.id : null,
      name: name,
      contact: $("f-contact").value.trim(),
      niche: $("f-niche").value.trim(),
      source: $("f-source").value,
      status: $("f-status").value,
      hook: $("f-hook").value.trim(),
      found: $("f-found").value.trim(),
      note: $("f-note").value.trim(),
      last: $("f-last").value,
      next: $("f-next").value,
      created: editing ? editing.created : "",
    }).then(function (data) {
      var wasEditing = !!editing;
      applyState(data);
      $("dlg").close();
      haptic("success");
      toast(wasEditing ? "Сохранено" : "Добавлен в базу");
    }).catch(fail).then(function () {
      busy = false;
      $("save").disabled = false;
    });
  }

  function delLead() {
    if (!editing || busy) return;
    var target = editing;
    confirmAsk("Удалить «" + (target.name || "") + "» из базы?").then(function (yes) {
      if (!yes) return;
      busy = true;
      api("/api/lead/delete", { id: target.id }).then(function (data) {
        applyState(data);
        $("dlg").close();
        toast("Удалено");
      }).catch(fail).then(function () { busy = false; });
    });
  }

  function updateBulkPreview() {
    var n = $("b-text").value.split("\n").filter(function (s) { return s.trim(); }).length;
    $("bulkPreview").textContent = n ? n + " строк" : "";
  }

  function saveBulk() {
    var text = $("b-text").value;
    if (!text.trim()) { $("b-text").focus(); return; }
    if (busy) return;
    busy = true;
    $("bulkSave").disabled = true;

    api("/api/bulk", { text: text, source: $("b-source").value, niche: $("b-niche").value.trim() })
      .then(function (data) {
        applyState(data);
        $("bulkDlg").close();
        $("b-text").value = "";
        updateBulkPreview();
        setTab("queue");
        haptic("success");
        toast("Добавлено: " + data.added + (data.skipped ? ", уже были в базе: " + data.skipped : ""));
      }).catch(fail).then(function () {
        busy = false;
        $("bulkSave").disabled = false;
      });
  }

  function setTab(next) {
    tab = next;
    try { localStorage.setItem("crm-tab", tab); } catch (e) {}
    render();
  }

  /* ---------- экран ожидания и ошибок ---------- */
  function showGate(title, text, retry) {
    $("gate").hidden = false;
    $("app").hidden = true;
    $("add").hidden = true;
    $("gateTitle").textContent = title;
    $("gateText").textContent = text || "";
    $("gateRetry").hidden = !retry;
  }

  function showApp() {
    $("gate").hidden = true;
    $("app").hidden = false;
    render();
  }

  function load() {
    return api("/api/state").then(function (data) {
      applyState(data);
      showApp();
    }).catch(function (err) {
      if (err.status === 401) {
        showGate("Telegram не подтвердил вход", err.message, true);
      } else if (err.status === 403) {
        showGate("Доступ закрыт", err.message);
      } else if (err.status === 503) {
        showGate("Почти готово", err.message, true);
      } else {
        showGate("Не смог загрузить базу", (err && err.message) || "Проверь связь и попробуй снова.", true);
      }
    });
  }

  /* ---------- запуск ---------- */
  document.addEventListener("click", function (e) {
    var act = e.target.closest("[data-act]");
    if (act) {
      var id = act.closest(".card").dataset.id;
      if (act.dataset.act === "wrote") wrote(id, act);
      else openForm(id);
      return;
    }
    var f = e.target.closest("[data-f]");
    if (f) { filter = f.dataset.f; render(); return; }
    var sf = e.target.closest("[data-sf]");
    if (sf) { srcFilter = sf.dataset.sf; render(); return; }
    var tb = e.target.closest("[data-tab]");
    if (tb) setTab(tb.dataset.tab);
  });

  $("q").addEventListener("input", function (e) { query = e.target.value; render(); });
  $("add").addEventListener("click", function () { openForm(null); });
  $("addOne").addEventListener("click", function () { openForm(null); });
  $("bulk").addEventListener("click", function () { $("bulkDlg").showModal(); });
  $("bulkCancel").addEventListener("click", function () { $("bulkDlg").close(); });
  $("b-text").addEventListener("input", updateBulkPreview);
  $("bulkForm").addEventListener("submit", function (e) { e.preventDefault(); saveBulk(); });
  $("cancel").addEventListener("click", function () { $("dlg").close(); });
  $("del").addEventListener("click", delLead);
  $("form").addEventListener("submit", function (e) { e.preventDefault(); saveForm(); });
  $("gateRetry").addEventListener("click", function () {
    showGate("Загружаю базу…", "");
    load();
  });

  // Пока приложение было свёрнуто, бот мог добавить людей — подтянем свежее.
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && dict && Date.now() - loadedAt > 5000) {
      api("/api/state").then(applyState).catch(function () {});
    }
  });

  if (tg) {
    tg.ready();
    // Имя владельца в заголовке: понятно, чья это база.
    var owner = tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.first_name;
    if (owner) document.querySelector(".top h1").textContent = "CRM " + owner;
    tg.expand();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
    document.documentElement.dataset.theme = tg.colorScheme === "dark" ? "dark" : "light";
    tg.onEvent("themeChanged", function () {
      document.documentElement.dataset.theme = tg.colorScheme === "dark" ? "dark" : "light";
    });
  }

  if (!initData) {
    showGate("Открой через Telegram", "Эта страница — мини-апп: она работает только внутри бота, который её выдал.");
  } else {
    load();
  }
})();
