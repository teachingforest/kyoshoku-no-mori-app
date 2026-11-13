// 教職の森 運営管理アプリ - フロントエンドロジック
// (AppSheet仕様 + Googleフォーム項目 + 調整さん風「月別・一括出欠登録・途中変更（ログイン自動割当・未回答通知バッジ）」+ 運営限定イベント + タスク/イベント3日前・1日前・当日プッシュ通知 + 左スライドドロワーメニュー + スワイプタブ切替 + Supabase RBAC & クラウドDB永久保存対応)

const STORAGE_KEY = "kyoshoku_no_mori_db_v5";
const PUSH_NOTIFIED_LOG_KEY = "kyoshoku_no_mori_push_log_v1";
const GOOGLE_FORM_URL = "https://forms.gle/3qK6Dyzrwr1ZJYTh8";
const DEFAULT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1CKIbToVcACvwItJYisJMtFfS7kYGg_1mH1-mbtqAXiY/edit?usp=sharing";

// GAS（Google Apps Script）Webアプリの URL（スプレッドシートの「役職」列を書き換える Webhook）
const GAS_ROLE_WEBHOOK_URL = window.GAS_ROLE_WEBHOOK_URL || "https://script.google.com/macros/s/AKfycbxgZmvJ8dbXt-hFCMYzfuxaxp2OZSyUJQG_jWTwJergMUhPmELv4ID8vH4aN2bthguP/exec";

// ==========================================================
// Supabase 接続設定 & RBAC（ロールベースアクセス制御）定義
// ==========================================================
const SUPABASE_URL = window.SUPABASE_URL || "https://taeqrjfoxcdtelvayqcl.supabase.co";
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "sb_publishable_icsQtKAeXicVmlgHEn4-Hg_Zbag0Kk2";

const supabaseClient =
  window.supabase &&
  SUPABASE_URL.startsWith("http") &&
  !SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
  !SUPABASE_ANON_KEY.includes("YOUR_SUPABASE_ANON_KEY")
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// 1. 役職（ロール）の定義（内部ロール値 & 日本語役職名の相互マッピング）
const RBAC_ROLES = [
  "president",      // 代表
  "vice_president", // 副代表
  "manager",        // 運営メンバー
  "student",        // 在校生
  "alumni",         // OB・OG
  "developer",      // 開発管理者
  "guest"           // 未承認（ログイン直後・名簿照合前の初期値）
];

const RBAC_ROLE_LABELS = {
  president: "代表",
  vice_president: "副代表",
  manager: "運営メンバー",
  student: "在校生",
  alumni: "OB・OG",
  developer: "開発管理者",
  guest: "未承認"
};

// 幹部・運営メンバー4役職の共通グループ（運営限定イベント閲覧・プッシュ通知の対象グループ）
const ADMIN_ROLES = ["president", "vice_president", "manager", "developer"];

// 2. 各種権限と役職ごとの権限マトリクス定義
const RBAC_PERMISSIONS = {
  csvDownload: ["president", "vice_president", "manager", "developer"],

  membersTabView: ["president", "vice_president", "manager", "developer"],
  membersCardView: ["president", "vice_president", "manager", "developer"],
  membersSearch: ["president", "vice_president", "manager", "developer"],
  membersAdd: ["president", "vice_president", "manager", "developer"],
  membersEdit: ["president", "vice_president", "manager", "developer"],
  changeRoleToManager: ["president", "vice_president", "developer"],
  changeRoleToVicePresident: ["vice_president", "developer"],
  changeRoleToPresident: ["president", "vice_president", "developer"],

  tasksTabView: ["president", "vice_president", "manager", "developer"],
  tasksSearch: ["president", "vice_president", "manager", "developer"],
  tasksEdit: ["president", "vice_president", "manager", "developer"],

  eventsTabView: ["president", "vice_president", "manager", "student", "alumni", "developer"],
  eventsCardView: ["president", "vice_president", "manager", "student", "alumni", "developer"],
  eventsSearch: ["president", "vice_president", "manager", "student", "alumni", "developer"],
  eventsEdit: ["president", "vice_president", "manager", "developer"],

  attendanceTabView: ["president", "vice_president", "manager", "student", "developer"],
  attendanceInput: ["president", "vice_president", "manager", "student", "developer"],
  attendanceManageDates: ["president", "vice_president", "manager", "developer"],

  membersView: ["president", "vice_president", "manager", "developer"],
  tasksAll: ["president", "vice_president", "manager", "developer"],
  eventsView: ["president", "vice_president", "manager", "student", "alumni", "developer"],
  attendanceViewAndInput: ["president", "vice_president", "manager", "student", "developer"]
};

function hasPermission(userRole, permissionKey) {
  const normalizedRole =
    RBAC_ROLES.includes(userRole) ? userRole : mapMemberRoleToRbacRole(userRole);
  const allowed = RBAC_PERMISSIONS[permissionKey] || [];
  return allowed.includes(normalizedRole);
}

// 指定したロール（内部ロール値または日本語役職名）が運営メンバー（ADMIN_ROLES）かどうかを判定
function isAdminRole(userRole = state.userRole) {
  const normalizedRole =
    RBAC_ROLES.includes(userRole) ? userRole : mapMemberRoleToRbacRole(userRole);
  return ADMIN_ROLES.includes(normalizedRole);
}

// 対象月シートの候補日のうち、指定したロールのユーザーが閲覧可能な日程リストを返す
function getVisibleDatesForRole(sheet, userRole = state.userRole) {
  if (!sheet || !Array.isArray(sheet.dates)) return [];
  const isAdmin = isAdminRole(userRole);
  return sheet.dates.filter(d => !d.adminOnly || isAdmin);
}

function canAssignMemberRole(userRole, targetRole) {
  const target = RBAC_ROLES.includes(targetRole) ? targetRole : mapMemberRoleToRbacRole(targetRole);
  switch (target) {
    case "developer":
      return userRole === "developer";
    case "president":
      return hasPermission(userRole, "changeRoleToPresident");
    case "vice_president":
      return hasPermission(userRole, "changeRoleToVicePresident");
    case "manager":
      return hasPermission(userRole, "changeRoleToManager");
    default:
      return hasPermission(userRole, "membersEdit");
  }
}

// Googleログイン実行（Supabase OAuth）
async function signInWithGoogle() {
  if (!supabaseClient) {
    alert(
      "Supabaseの接続URL（SUPABASE_URL / SUPABASE_ANON_KEY）が未設定です。\n画面上部の「🔐 現在の役職(RBAC)」プルダウンから各ロールの表示制御を直接テストできます。"
    );
    return;
  }
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin + window.location.pathname
    }
  });
  if (error) {
    alert(`Googleログインエラー: ${error.message}`);
  }
}

// ログアウト実行
async function signOutUser() {
  if (supabaseClient) {
    await supabaseClient.auth.signOut();
  }
  state.currentUser = null;
  state.userRole = "guest";
  applyRbacUi(state.userRole);
}

function mapMemberRoleToRbacRole(memberRole) {
  const normalized = String(memberRole ?? "").trim();
  const roleMap = {
    "開発管理者": "developer",
    "developer": "developer",
    "代表": "president",
    "president": "president",
    "副代表": "vice_president",
    "vice_president": "vice_president",
    "運営メンバー": "manager",
    "manager": "manager",
    "在校生": "student",
    "student": "student",
    "OB・OG": "alumni",
    "alumni": "alumni"
  };
  return roleMap[normalized] || "student";
}

function rbacRoleToLabel(role) {
  return RBAC_ROLE_LABELS[role] || role;
}

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

// ログイン中のユーザー（state.currentUser.email）に対応する名簿メンバー（db.members）を自動取得する関数
function getCurrentLoggedInMember() {
  const myEmail = normalizeEmail(state.currentUser?.email);
  if (myEmail) {
    const matched = db.members.find(m => normalizeEmail(m.email) === myEmail);
    if (matched) return matched;
  }
  if (state.currentUser && db.members.length === 1) {
    return db.members[0];
  }
  return null;
}

// ==========================================================
// 左スライドドロワーメニュー（三本線メニュー）の開閉制御
// ==========================================================
function openSideDrawer() {
  document.getElementById("drawerBackdrop")?.classList.add("open");
  document.getElementById("sideDrawer")?.classList.add("open");
}

function closeSideDrawer() {
  document.getElementById("drawerBackdrop")?.classList.remove("open");
  document.getElementById("sideDrawer")?.classList.remove("open");
}

// ==========================================================
// 未回答の月を判定し、「出欠調整」タブの右上に通知バッジを表示するロジック
// ==========================================================

function isMonthAnsweredByMember(sheet, memberSysId) {
  if (!sheet || !Array.isArray(sheet.dates) || sheet.dates.length === 0) {
    return true;
  }
  if (!memberSysId) return true;

  const memberObj = db.members.find(m => m.sysId === memberSysId);
  const memberRole = memberObj ? memberObj.role : state.userRole;
  const visibleDates = getVisibleDatesForRole(sheet, memberRole);

  if (visibleDates.length === 0) {
    return true;
  }

  const resp = sheet.responses?.[memberSysId];
  if (!resp || !resp.marks) return false;

  return visibleDates.every(d => {
    const mk = resp.marks[d.dateId];
    return MARK_OPTIONS.includes(mk);
  });
}

function getUnansweredMonthsForCurrentUser() {
  if (!hasPermission(state.userRole, "attendanceInput")) return [];
  const myMember = getCurrentLoggedInMember();
  if (!myMember) return [];

  const monthKeys = Object.keys(db.monthlySchedules || {}).sort();
  return monthKeys.filter(ym => {
    const sheet = db.monthlySchedules[ym];
    return !isMonthAnsweredByMember(sheet, myMember.sysId);
  });
}

function updateAttendanceNotificationBadge() {
  const navBtn = document.querySelector('.bottom-nav .nav-item[data-view="attendance"]');
  if (!navBtn) return;

  let badgeEl = document.getElementById("attendanceNavBadge");
  const unansweredMonths = getUnansweredMonthsForCurrentUser();
  const count = unansweredMonths.length;

  if (count === 0) {
    if (badgeEl) badgeEl.style.display = "none";
    return;
  }

  if (!badgeEl) {
    badgeEl = document.createElement("span");
    badgeEl.id = "attendanceNavBadge";
    badgeEl.style.cssText = [
      "position: absolute",
      "top: 4px",
      "right: calc(50% - 26px)",
      "min-width: 18px",
      "height: 18px",
      "padding: 0 5px",
      "border-radius: 999px",
      "background: #dc2626",
      "color: #ffffff",
      "font-size: 0.68rem",
      "font-weight: 800",
      "line-height: 18px",
      "text-align: center",
      "box-shadow: 0 1px 4px rgba(220, 38, 38, 0.45)",
      "border: 1.5px solid #ffffff",
      "pointer-events: none",
      "z-index: 5"
    ].join(";");
    navBtn.appendChild(badgeEl);
  }

  badgeEl.textContent = count > 9 ? "9+" : String(count);
  badgeEl.title = `未回答の出欠表が ${count}ヶ月分 あります`;
  badgeEl.style.display = "inline-block";
}

// ==========================================================
// 運営メンバー向けプッシュ通知機能（タスク・イベントの3日前 / 1日前 / 当日）
// ==========================================================
const REMINDER_TARGET_DAYS = [3, 1, 0];

function getDaysUntilIsoDate(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const [ty, tm, td] = getTodayIsoString().split("-").map(Number);
  const [y, m, d] = isoDate.split("-").map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const targetUtc = Date.UTC(y, m - 1, d);
  return Math.round((targetUtc - todayUtc) / (1000 * 60 * 60 * 24));
}

function getActiveAdminReminders() {
  if (!isAdminRole(state.userRole)) return [];

  const reminders = [];
  const todayIso = getTodayIsoString();

  // 1. タスクの判定（ステータスが「完了」以外 ＆ 期日まであと 3日 / 1日 / 0日）
  (db.tasks || []).forEach(t => {
    if (!t || t.status === "完了" || !t.dueDate) return;
    const diff = getDaysUntilIsoDate(t.dueDate);
    if (diff !== null && REMINDER_TARGET_DAYS.includes(diff)) {
      reminders.push({
        key: `task_${t.sysId}_${todayIso}_d${diff}`,
        type: "task",
        sysId: t.sysId,
        diffDays: diff,
        targetDate: t.dueDate,
        title: t.taskName,
        status: t.status,
        message: `タスク「${t.taskName}」期日まであと${diff}日`
      });
    }
  });

  // 2. イベントの判定（開催日まであと 3日 / 1日 / 0日）
  (db.events || []).forEach(ev => {
    if (!ev || !ev.eventDate) return;
    const diff = getDaysUntilIsoDate(ev.eventDate);
    if (diff !== null && REMINDER_TARGET_DAYS.includes(diff)) {
      reminders.push({
        key: `event_${ev.sysId}_${todayIso}_d${diff}`,
        type: "event",
        sysId: ev.sysId,
        diffDays: diff,
        targetDate: ev.eventDate,
        title: ev.eventName,
        adminOnly: Boolean(ev.adminOnly),
        message: `${diff}日後に「${ev.eventName}」全体にリマインド`
      });
    }
  });

  reminders.sort((a, b) => a.diffDays - b.diffDays);
  return reminders;
}

function loadPushNotifiedLog() {
  try {
    const raw = localStorage.getItem(PUSH_NOTIFIED_LOG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function savePushNotifiedLog(logObj) {
  try {
    localStorage.setItem(PUSH_NOTIFIED_LOG_KEY, JSON.stringify(logObj));
  } catch (_) {}
}

function sendBrowserNativeNotification(reminder) {
  if (!("Notification" in window)) return false;
  if (Notification.permission !== "granted") return false;

  try {
    const title =
      reminder.type === "task"
        ? "⏰ タスク期日リマインド（教職の森）"
        : "📢 イベント告知リマインド（教職の森）";

    const n = new Notification(title, {
      body: reminder.message,
      tag: reminder.key
    });

    n.onclick = () => {
      window.focus();
      if (reminder.type === "task") {
        state.currentView = "tasks";
        renderFilters();
        renderView();
        openTaskDetailModal(reminder.sysId);
      } else {
        state.currentView = "events";
        renderFilters();
        renderView();
        openEventDetailModal(reminder.sysId);
      }
      n.close();
    };
    return true;
  } catch (err) {
    console.warn("Native notification failed:", err);
    return false;
  }
}

function showInAppPushToast(reminders) {
  if (!Array.isArray(reminders) || reminders.length === 0) return;

  let container = document.getElementById("pushToastContainer");
  if (!container) {
    container = document.createElement("div");
    container.id = "pushToastContainer";
    container.style.cssText = [
      "position: fixed",
      "top: 14px",
      "left: 50%",
      "transform: translateX(-50%)",
      "width: calc(100% - 24px)",
      "max-width: 460px",
      "z-index: 90",
      "display: flex",
      "flex-direction: column",
      "gap: 8px",
      "pointer-events: none"
    ].join(";");
    document.body.appendChild(container);
  }

  container.innerHTML = `
    <div style="pointer-events: auto; background: #1e293b; color: #f8fafc; border-left: 5px solid #f59e0b; border-radius: 12px; padding: 12px 14px; box-shadow: 0 12px 28px rgba(0,0,0,0.28); font-size: 0.84rem;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <strong style="color: #fbbf24; font-size: 0.86rem;">🔔 運営メンバー向けリマインド通知（${reminders.length}件）</strong>
        <button type="button" id="btnClosePushToast" style="background: transparent; border: none; color: #94a3b8; font-size: 1.1rem; cursor: pointer; padding: 0 4px;">×</button>
      </div>
      <div style="display: flex; flex-direction: column; gap: 5px; max-height: 150px; overflow-y: auto;">
        ${reminders
          .map(
            r => `
              <div
                data-toast-jump-type="${escapeHtml(r.type)}"
                data-toast-jump-id="${escapeHtml(r.sysId)}"
                style="background: rgba(255,255,255,0.08); padding: 7px 10px; border-radius: 8px; cursor: pointer; font-weight: 700; display: flex; align-items: center; gap: 6px;"
              >
                <span>${r.type === "task" ? "✅" : "📅"}</span>
                <span style="flex: 1;">${escapeHtml(r.message)}</span>
                <span style="font-size: 0.72rem; color: #cbd5e1;">詳細 ›</span>
              </div>
            `
          )
          .join("")}
      </div>
    </div>
  `;

  document.getElementById("btnClosePushToast")?.addEventListener("click", () => {
    container.innerHTML = "";
  });

  container.querySelectorAll("[data-toast-jump-id]").forEach(item => {
    item.addEventListener("click", () => {
      const type = item.dataset.toastJumpType;
      const sysId = item.dataset.toastJumpId;
      container.innerHTML = "";
      if (type === "task") {
        state.currentView = "tasks";
        renderFilters();
        renderView();
        openTaskDetailModal(sysId);
      } else {
        state.currentView = "events";
        renderFilters();
        renderView();
        openEventDetailModal(sysId);
      }
    });
  });

  setTimeout(() => {
    if (container) container.innerHTML = "";
  }, 10000);
}

function checkAndTriggerAdminPushNotifications(forceShowToast = false) {
  updateHeaderNotificationBell();

  if (!isAdminRole(state.userRole)) return;

  const reminders = getActiveAdminReminders();
  if (reminders.length === 0) return;

  const log = loadPushNotifiedLog();
  const newlyTriggered = [];

  reminders.forEach(r => {
    if (!log[r.key]) {
      sendBrowserNativeNotification(r);
      log[r.key] = Date.now();
      newlyTriggered.push(r);
    }
  });

  if (newlyTriggered.length > 0) {
    savePushNotifiedLog(log);
    showInAppPushToast(newlyTriggered);
  } else if (forceShowToast) {
    showInAppPushToast(reminders);
  }
}

// ドロワー内の「🔔 通知」項目および三本線メニューアイコンのバッジを更新
function updateHeaderNotificationBell() {
  const bellBtn = document.getElementById("btnHeaderNotifications");
  const drawerBadge = document.getElementById("drawerNotificationBadge");
  const hamburgerBadge = document.getElementById("hamburgerNotificationBadge");
  const isAdmin = isAdminRole(state.userRole);

  if (!isAdmin) {
    if (bellBtn) bellBtn.style.display = "none";
    if (drawerBadge) drawerBadge.style.display = "none";
    if (hamburgerBadge) hamburgerBadge.style.display = "none";
    return;
  }

  if (bellBtn) bellBtn.style.display = "flex";
  const reminders = getActiveAdminReminders();
  const count = reminders.length;

  if (drawerBadge) {
    if (count > 0) {
      drawerBadge.textContent = String(count);
      drawerBadge.style.display = "inline-block";
    } else {
      drawerBadge.style.display = "none";
    }
  }

  if (hamburgerBadge) {
    if (count > 0) {
      hamburgerBadge.textContent = count > 9 ? "9+" : String(count);
      hamburgerBadge.style.display = "inline-block";
    } else {
      hamburgerBadge.style.display = "none";
    }
  }
}

// 「🔔 通知」を押したときに開く運営メンバー向けリマインド管理モーダル
function openNotificationsModal() {
  closeSideDrawer();
  state.modalMode = "notificationsModal";
  state.editingSysId = null;
  resetFormModalButtons(true);

  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");
  const btnSwitchToEdit = document.getElementById("btnSwitchToEdit");

  if (btnDelete) btnDelete.style.display = "none";
  if (btnSwitchToEdit) btnSwitchToEdit.style.display = "none";

  titleEl.textContent = "🔔 運営メンバー向けリマインド通知";

  const reminders = getActiveAdminReminders();
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const permLabel =
    perm === "granted"
      ? "✅ プッシュ通知：許可済み（有効）"
      : perm === "denied"
      ? "⚠️ プッシュ通知：ブラウザ設定でブロックされています"
      : perm === "default"
      ? "🔕 プッシュ通知：未設定（下のボタンからONにできます）"
      : "ℹ️ このブラウザはOSプッシュ通知非対応です（アプリ内通知バナーで動作します）";

  bodyEl.innerHTML = `
    <div class="detail-item" style="background: #f0fdf4; border-color: #bbf7d0;">
      <div class="detail-label" style="color: #166534;">📲 デバイスのプッシュ通知設定</div>
      <div style="font-size: 0.85rem; font-weight: 700; color: var(--text-main); margin-top: 4px;">
        ${permLabel}
      </div>
      <div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 4px; line-height: 1.5;">
        タスク（未完了）とイベントの<strong>3日前・1日前・当日（0日後）</strong>に、運営メンバーへ自動でプッシュ通知を行います。
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px;">
        ${perm === "default"
          ? `<button type="button" class="btn btn-primary" id="btnEnableBrowserPush" style="font-size: 0.8rem; padding: 6px 12px;">🔔 プッシュ通知をONにする</button>`
          : ""
        }
        <button type="button" class="btn btn-secondary" id="btnTestPushNow" style="font-size: 0.8rem; padding: 6px 12px;">
          📣 今すぐ通知をテスト送信
        </button>
      </div>
    </div>

    <div class="form-group" style="margin-top: 4px;">
      <label class="form-label">
        📋 本日のリマインド対象（3日前・1日前・当日：${reminders.length}件）
      </label>
      ${reminders.length === 0
        ? `
          <div class="empty-state" style="padding: 24px 14px;">
            本日通知対象（3日前・1日前・当日）の未完了タスクやイベントはありません。
          </div>
        `
        : `
          <div class="list-stack" style="margin-top: 4px;">
            ${reminders
              .map(r => {
                const badgeBg =
                  r.diffDays === 0
                    ? "background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;"
                    : r.diffDays === 1
                    ? "background: #fef3c7; color: #92400e; border: 1px solid #fde68a;"
                    : "background: #e0f2fe; color: #075985; border: 1px solid #bae6fd;";
                const dayLabel = r.diffDays === 0 ? "当日（0日後）" : `${r.diffDays}日前`;
                return `
                  <div
                    class="list-row item-card-clickable"
                    data-reminder-type="${escapeHtml(r.type)}"
                    data-reminder-id="${escapeHtml(r.sysId)}"
                    style="padding: 12px 14px; flex-direction: row; align-items: center; justify-content: space-between; gap: 10px;"
                  >
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                      <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                        <span class="badge" style="${badgeBg}">${dayLabel}</span>
                        <span class="badge badge-id">${escapeHtml(r.targetDate)}</span>
                        ${r.type === "task"
                          ? `<span class="badge ${getStatusBadgeClass(r.status)}">${escapeHtml(r.status)}</span>`
                          : `<span class="badge event-status-active">イベント</span>`
                        }
                      </div>
                      <div style="font-size: 0.95rem; font-weight: 800; color: var(--text-main); margin-top: 2px;">
                        ${escapeHtml(r.message)}
                      </div>
                    </div>
                    <span class="card-chevron">›</span>
                  </div>
                `;
              })
              .join("")}
          </div>
        `
      }
    </div>
  `;

  document.getElementById("btnEnableBrowserPush")?.addEventListener("click", async () => {
    if (!("Notification" in window)) {
      alert("お使いのブラウザはOSのプッシュ通知に対応していません。");
      return;
    }
    const res = await Notification.requestPermission();
    if (res === "granted") {
      new Notification("🌲 教職の森 運営管理アプリ", {
        body: "プッシュ通知が有効になりました！タスクとイベントの3日前・1日前・当日に通知します。"
      });
    }
    openNotificationsModal();
  });

  document.getElementById("btnTestPushNow")?.addEventListener("click", async () => {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
    if (reminders.length > 0) {
      reminders.forEach(r => sendBrowserNativeNotification(r));
      showInAppPushToast(reminders);
    } else {
      const sample = [
        {
          key: "test_task",
          type: "task",
          sysId: "",
          diffDays: 3,
          message: "タスク「サンプル資料作成」期日まであと3日"
        },
        {
          key: "test_event",
          type: "event",
          sysId: "",
          diffDays: 3,
          message: "3日後に「定例ミーティング」全体にリマインド"
        }
      ];
      sample.forEach(s => sendBrowserNativeNotification(s));
      showInAppPushToast(sample);
    }
  });

  bodyEl.querySelectorAll("[data-reminder-id]").forEach(row => {
    row.addEventListener("click", () => {
      const type = row.dataset.reminderType;
      const sysId = row.dataset.reminderId;
      if (!sysId) return;
      closeFormModal();
      if (type === "task") {
        state.currentView = "tasks";
        renderFilters();
        renderView();
        openTaskDetailModal(sysId);
      } else {
        state.currentView = "events";
        renderFilters();
        renderView();
        openEventDetailModal(sysId);
      }
    });
  });

  modal.classList.add("open");
}

// ==========================================================
// スマホ画面の左右スワイプ操作でタブを移動する機能
// ==========================================================
function switchViewWithDirection(targetView, direction = null) {
  if (!targetView || targetView === state.currentView) return;
  state.currentView = targetView;
  state.searchQuery = "";
  const searchInput = document.getElementById("searchInput");
  if (searchInput) searchInput.value = "";

  renderFilters();
  renderView();

  const contentEl = document.getElementById("viewContent");
  if (contentEl && direction) {
    contentEl.classList.remove("swipe-in-right", "swipe-in-left");
    void contentEl.offsetWidth;
    contentEl.classList.add(direction === "next" ? "swipe-in-right" : "swipe-in-left");
  }

  const phoneViewport = document.querySelector(".phone-viewport");
  if (phoneViewport) phoneViewport.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function initSwipeTabNavigation() {
  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let ignoreSwipe = false;

  document.addEventListener(
    "touchstart",
    e => {
      if (!e.touches || e.touches.length !== 1) {
        ignoreSwipe = true;
        return;
      }

      if (
        document.querySelector(".modal-backdrop.open") ||
        document.getElementById("sideDrawer")?.classList.contains("open")
      ) {
        ignoreSwipe = true;
        return;
      }

      const targetEl = e.target;
      if (targetEl && targetEl.closest("input, textarea, select")) {
        ignoreSwipe = true;
        return;
      }

      const hScrollable = targetEl?.closest(".matrix-scroll, .db-table-wrap");
      if (hScrollable && hScrollable.scrollWidth > hScrollable.clientWidth) {
        ignoreSwipe = true;
        return;
      }

      ignoreSwipe = false;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    },
    { passive: true }
  );

  document.addEventListener(
    "touchend",
    e => {
      if (ignoreSwipe || !e.changedTouches || e.changedTouches.length !== 1) return;

      const deltaX = e.changedTouches[0].clientX - touchStartX;
      const deltaY = e.changedTouches[0].clientY - touchStartY;
      const elapsed = Date.now() - touchStartTime;

      if (
        elapsed > 800 ||
        Math.abs(deltaX) < 55 ||
        Math.abs(deltaX) < Math.abs(deltaY) * 1.4
      ) {
        return;
      }

      const visibleViews = Array.from(document.querySelectorAll(".bottom-nav .nav-item"))
        .filter(btn => btn.style.display !== "none")
        .map(btn => btn.dataset.view)
        .filter(Boolean);

      if (visibleViews.length <= 1) return;

      const currentIdx = visibleViews.indexOf(state.currentView);
      if (currentIdx === -1) return;

      if (deltaX < 0 && currentIdx < visibleViews.length - 1) {
        switchViewWithDirection(visibleViews[currentIdx + 1], "next");
      } else if (deltaX > 0 && currentIdx > 0) {
        switchViewWithDirection(visibleViews[currentIdx - 1], "prev");
      }
    },
    { passive: true }
  );
}

// ==========================================================
// Supabase の profiles テーブルのロール情報を名簿（db.members）のカード表示へ紐づけて同期する関数
// ==========================================================
async function syncMemberRolesFromSupabase() {
  if (!supabaseClient || !state.currentUser) return false;

  try {
    const { data: profiles, error } = await supabaseClient
      .from("profiles")
      .select("email, role");

    if (error || !Array.isArray(profiles)) return false;

    const emailToRoleMap = new Map();
    profiles.forEach(p => {
      const em = normalizeEmail(p.email);
      if (em && p.role && RBAC_ROLES.includes(p.role) && p.role !== "guest") {
        emailToRoleMap.set(em, p.role);
      }
    });

    let changed = false;
    const myEmail = normalizeEmail(state.currentUser.email);
    const myRole = state.userRole;

    if (myEmail && !db.members.some(m => normalizeEmail(m.email) === myEmail)) {
      const selfCandidate =
        db.members.find(m => m.studentId === "2301196" && !normalizeEmail(m.email)) ||
        (db.members.length === 1 && !normalizeEmail(db.members[0].email) ? db.members[0] : null);

      if (selfCandidate) {
        selfCandidate.email = myEmail;
        changed = true;
      }
    }

    db.members.forEach(m => {
      const memEmail = normalizeEmail(m.email);
      if (!memEmail) return;

      const supaRole = emailToRoleMap.get(memEmail) || (memEmail === myEmail ? myRole : null);
      if (supaRole && supaRole !== "guest") {
        const label = rbacRoleToLabel(supaRole);
        if (ROLE_OPTIONS.includes(label) && m.role !== label) {
          m.role = label;
          changed = true;
        }
      }
    });

    if (changed) {
      saveDb();
    }
    return changed;
  } catch (err) {
    console.warn("Failed to sync member roles from Supabase profiles:", err);
    return false;
  }
}

// ==========================================================
// Supabase `app_data` テーブルとのクラウド同期（タスク・イベント・出欠データの永久保存）
// ==========================================================
async function loadCloudDb() {
  if (!supabaseClient || !state.currentUser || state.userRole === "guest") return false;

  try {
    const { data: row, error } = await supabaseClient
      .from("app_data")
      .select("data, updated_at")
      .eq("id", "main")
      .maybeSingle();

    if (error) {
      console.warn("Supabase app_data 読み込みスキップ（SQL未実行またはRLS制限）:", error.message);
      return false;
    }

    if (row && row.data && typeof row.data === "object" && Object.keys(row.data).length > 0) {
      const cloud = row.data;
      if (Array.isArray(cloud.members) && cloud.members.length > 0) {
        db.members = cloud.members;
      }
      if (Array.isArray(cloud.tasks)) {
        db.tasks = cloud.tasks;
      }
      if (Array.isArray(cloud.events)) {
        db.events = cloud.events;
      }
      if (cloud.monthlySchedules && typeof cloud.monthlySchedules === "object") {
        db.monthlySchedules = cloud.monthlySchedules;
      }
      if (cloud.sheetSyncUrl) {
        db.sheetSyncUrl = cloud.sheetSyncUrl;
      }
      if (cloud.lastSyncedAt) {
        db.lastSyncedAt = cloud.lastSyncedAt;
      }

      reconcileEventsAndSchedules(db);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      return true;
    } else {
      await saveCloudDb();
      return true;
    }
  } catch (err) {
    console.warn("Failed to load cloud DB:", err);
    return false;
  }
}

async function saveCloudDb() {
  if (!supabaseClient || !state.currentUser || state.userRole === "guest") return false;

  try {
    const payload = {
      id: "main",
      data: {
        sheetSyncUrl: db.sheetSyncUrl || DEFAULT_SHEET_URL,
        lastSyncedAt: db.lastSyncedAt || "",
        members: db.members || [],
        tasks: db.tasks || [],
        events: db.events || [],
        monthlySchedules: db.monthlySchedules || {}
      },
      updated_by: state.currentUser.id
    };

    const { error } = await supabaseClient
      .from("app_data")
      .upsert(payload, { onConflict: "id" });

    if (error) {
      console.warn("Supabase app_data 保存エラー:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("Failed to save cloud DB:", err);
    return false;
  }
}

// アプリ起動時（またはログイン時）に profiles テーブルから自分の role を取得する
async function fetchCurrentUserRole() {
  if (!supabaseClient) {
    return state.userRole || "developer";
  }

  try {
    const {
      data: { user },
      error: authErr
    } = await supabaseClient.auth.getUser();

    if (authErr || !user) {
      state.currentUser = null;
      return "guest";
    }

    state.currentUser = user;

    const { data: profile, error: profErr } = await supabaseClient
      .from("profiles")
      .select("role, email")
      .eq("id", user.id)
      .single();

    let currentRole =
      !profErr && profile && RBAC_ROLES.includes(profile.role)
        ? profile.role
        : "guest";

    if (currentRole === "guest" && state.currentUser.email) {
      if (db.sheetSyncUrl) {
        try {
          const rows = await loadGoogleSheetViaJsonp(db.sheetSyncUrl);
          mergeMembersFromRows(rows);
        } catch (syncErr) {
          console.warn("自動ロール照合前のスプレッドシート同期をスキップしました:", syncErr);
        }
      }

      const loginEmail = normalizeEmail(state.currentUser.email);
      const matchedMember = db.members.find(
        m => m.email && normalizeEmail(m.email) === loginEmail
      );

      if (matchedMember) {
        const assignedRole = mapMemberRoleToRbacRole(matchedMember.role);

        const { error: updateErr } = await supabaseClient
          .from("profiles")
          .update({ role: assignedRole })
          .eq("id", state.currentUser.id);

        if (!updateErr) {
          currentRole = assignedRole;
        } else {
          console.error("Failed to auto-update user role in profiles:", updateErr);
        }
      }
    }

    state.userRole = currentRole;

    // 1. Supabaseから共有データ（タスク・イベント・出欠・名簿）を読み込む
    await loadCloudDb();

    // 2. Supabase上のロール情報（開発管理者など）を名簿カード（db.members）の表示に反映
    await syncMemberRolesFromSupabase();

    return currentRole;
  } catch (e) {
    console.error("Failed to fetch user role from profiles:", e);
    return "guest";
  }
}

// ==========================================================
// 管理者による他メンバーの役職（ロール）変更 → Supabase profiles.role へ自動反映
// ==========================================================

async function updateMemberRole(targetEmail, newRole, options = {}) {
  const { previousRole = null, silent = false } = options;
  const email = normalizeEmail(targetEmail);
  const nextRbacRole = RBAC_ROLES.includes(newRole) ? newRole : mapMemberRoleToRbacRole(newRole);
  const nextLabel = rbacRoleToLabel(nextRbacRole);
  const notify = msg => {
    if (!silent) alert(msg);
  };

  if (
    !canAssignMemberRole(state.userRole, nextRbacRole) ||
    (previousRole && !canAssignMemberRole(state.userRole, previousRole))
  ) {
    notify("更新に失敗しました：現在のあなたの役職では、この役職変更を行う権限がありません。");
    return { ok: false, reason: "forbidden" };
  }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    notify("更新に失敗しました：対象メンバーのメールアドレスが未登録のため、Supabaseのアカウントを特定できません。");
    return { ok: false, reason: "no_email" };
  }

  if (!supabaseClient) {
    notify(`Supabase未接続のため、アプリ内の名簿のみ「${nextLabel}」に更新しました（ローカルプレビューモード）。`);
    return { ok: true, reason: "offline" };
  }

  try {
    const { data: found, error: findErr } = await supabaseClient
      .from("profiles")
      .select("id, role")
      .eq("email", email);

    if (findErr) throw findErr;

    if (!found || found.length === 0) {
      const sheetResult = await syncRoleToSpreadsheet(email, nextLabel);
      notify(
        `「${email}」はまだアプリにログインしていないため、Supabase上のアカウントがありません。\n` +
          "アプリ内の名簿の役職を更新しました（本人が初回ログインした際に自動的にこの役職が付与されます）。" +
          (sheetResult.message ? `\n※${sheetResult.message}` : "")
      );
      return { ok: true, reason: "not_registered" };
    }

    const { data: updated, error: updateErr } = await supabaseClient
      .from("profiles")
      .update({ role: nextRbacRole })
      .eq("email", email)
      .select("id, role");

    if (updateErr) throw updateErr;

    if (!updated || updated.length === 0) {
      notify("更新に失敗しました：Supabase側の権限（RLSポリシー）により役職の変更が拒否されました。");
      return { ok: false, reason: "rls_denied" };
    }

    if (state.currentUser && updated.some(row => row.id === state.currentUser.id)) {
      state.userRole = nextRbacRole;
    }

    const sheetResult = await syncRoleToSpreadsheet(email, nextLabel);

    notify(
      `権限を更新しました（${email} → ${nextLabel}）` +
        (sheetResult.message ? `\n※${sheetResult.message}` : "")
    );
    return { ok: true, reason: "updated" };
  } catch (err) {
    console.error("Failed to update member role in profiles:", err);
    notify(`更新に失敗しました：${err?.message || err}`);
    return { ok: false, reason: "error" };
  }
}

async function syncRoleToSpreadsheet(email, roleLabel) {
  if (!GAS_ROLE_WEBHOOK_URL) {
    return { ok: false, message: "" };
  }

  try {
    let accessToken = "";
    if (supabaseClient) {
      const {
        data: { session }
      } = await supabaseClient.auth.getSession();
      accessToken = session?.access_token || "";
    }

    await fetch(GAS_ROLE_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ email, role: roleLabel, accessToken })
    });

    return { ok: true, message: "スプレッドシートの役職列へも更新リクエストを送信しました。" };
  } catch (err) {
    console.error("Failed to sync role to spreadsheet:", err);
    return { ok: false, message: `スプレッドシートの役職更新に失敗しました（${err?.message || err}）。` };
  }
}

// ドロワーメニュー内のユーザー情報・ログイン/ログアウト表示を更新
function updateHeaderAuthButtons() {
  const authBtn = document.getElementById("btnGoogleAuth");
  if (authBtn) {
    authBtn.textContent = state.currentUser ? "🚪 ログアウト" : "🔑 Googleログイン";
  }

  const headerAuthIcon = document.getElementById("btnHeaderAuthIcon");
  const headerAuthText = document.getElementById("btnHeaderAuthText");
  const drawerUserBox = document.getElementById("drawerUserBox");

  if (headerAuthIcon && headerAuthText) {
    if (state.currentUser) {
      headerAuthIcon.textContent = "🚪";
      headerAuthText.textContent = "ログアウト";
    } else {
      headerAuthIcon.textContent = "🔑";
      headerAuthText.textContent = "ログイン";
    }
  }

  if (drawerUserBox) {
    const roleLabel = rbacRoleToLabel(state.userRole);
    const myMember = getCurrentLoggedInMember();
    if (state.currentUser) {
      drawerUserBox.innerHTML = `
        <div style="font-weight: 800; color: var(--text-main); font-size: 0.88rem;">
          ${escapeHtml(myMember ? myMember.name : "ログイン中")}
          <span class="badge ${getRoleBadgeClass(roleLabel)}" style="margin-left: 4px;">${escapeHtml(roleLabel)}</span>
        </div>
        <div style="font-size: 0.74rem; color: var(--text-muted); word-break: break-all; margin-top: 2px;">
          ${escapeHtml(state.currentUser.email || "")}
        </div>
      `;
    } else {
      drawerUserBox.innerHTML = `
        <div style="font-weight: 700; color: var(--text-muted);">
          未ログイン（権限: ${escapeHtml(roleLabel)}）
        </div>
      `;
    }
  }
}

function applyRbacUi(userRole = state.userRole) {
  const validRole = RBAC_ROLES.includes(userRole) ? userRole : "guest";
  state.userRole = validRole;

  const switcher = document.getElementById("rbacRoleSwitcher");
  if (switcher && switcher.value !== validRole) {
    switcher.value = validRole;
  }

  updateHeaderAuthButtons();
  updateAttendanceNotificationBadge();
  updateHeaderNotificationBell();

  const tabAccess = {
    members: hasPermission(validRole, "membersTabView"),
    tasks: hasPermission(validRole, "tasksTabView"),
    events: hasPermission(validRole, "eventsTabView"),
    attendance: hasPermission(validRole, "attendanceTabView")
  };

  let visibleTabCount = 0;
  document.querySelectorAll(".bottom-nav .nav-item").forEach(btn => {
    const viewName = btn.dataset.view;
    const allowed = Boolean(tabAccess[viewName]);
    btn.style.display = allowed ? "flex" : "none";
    if (allowed) visibleTabCount++;
  });

  const bottomNav = document.querySelector(".bottom-nav");
  if (bottomNav) {
    bottomNav.style.display = visibleTabCount > 0 ? "flex" : "none";
  }

  const navInner = document.querySelector(".bottom-nav-inner");
  if (navInner) {
    navInner.style.gridTemplateColumns =
      visibleTabCount > 0 ? `repeat(${visibleTabCount}, 1fr)` : "1fr";
  }

  // ドロワーメニュー内の各項目の表示/非表示制御
  const btnOpenDbModal = document.getElementById("btnOpenDbModal");
  const btnDownloadCsv = document.getElementById("btnDownloadCsv");
  const btnOpenSyncModal = document.getElementById("btnOpenSyncModal");

  if (btnOpenDbModal) {
    btnOpenDbModal.style.display = hasPermission(validRole, "csvDownload") ? "flex" : "none";
  }
  if (btnDownloadCsv) {
    btnDownloadCsv.style.display = hasPermission(validRole, "csvDownload") ? "inline-block" : "none";
  }
  if (btnOpenSyncModal) {
    btnOpenSyncModal.style.display = hasPermission(validRole, "membersAdd") ? "flex" : "none";
  }

  document.querySelectorAll("#dbSheetTabs .view-toggle-btn").forEach(btn => {
    const s = btn.dataset.sheet;
    const allowed = Boolean(tabAccess[s]);
    btn.style.display = allowed ? "inline-block" : "none";
  });

  if (!tabAccess[state.currentView]) {
    const firstAllowedView = Object.keys(tabAccess).find(k => tabAccess[k]);
    if (firstAllowedView) {
      state.currentView = firstAllowedView;
      renderFilters();
      renderView();
      return;
    } else {
      const titleEl = document.getElementById("currentViewTitle");
      const countEl = document.getElementById("currentViewCount");
      const contentEl = document.getElementById("viewContent");
      const toolbar = document.querySelector(".toolbar-controls");
      const fab = document.getElementById("btnAddRecord");
      const btnClearTab = document.getElementById("btnClearCurrentTab");
      const eventsToggleWrap = document.getElementById("eventsViewToggleWrap");

      if (toolbar) toolbar.style.display = "none";
      if (fab) fab.style.display = "none";
      if (btnClearTab) btnClearTab.style.display = "none";
      if (eventsToggleWrap) eventsToggleWrap.style.display = "none";

      if (!state.currentUser) {
        if (titleEl) titleEl.textContent = "ログイン";
        if (countEl) countEl.textContent = "未ログイン";
        if (contentEl) {
          contentEl.innerHTML = `
            <div class="item-card" style="max-width: 440px; margin: 18px auto; padding: 28px 22px; text-align: center; align-items: center; gap: 16px;">
              <div style="width: 64px; height: 64px; border-radius: 18px; background: var(--primary-pale); color: var(--primary-dark); display: flex; align-items: center; justify-content: center; font-size: 2rem; box-shadow: var(--shadow-sm);">
                🌲
              </div>
              <div>
                <h2 style="font-size: 1.2rem; font-weight: 800; color: var(--primary-dark); margin-bottom: 6px;">
                  教職の森 運営管理アプリ
                </h2>
                <p style="font-size: 0.86rem; color: var(--text-muted); line-height: 1.6;">
                  サークルメンバー専用の管理アプリです。<br />
                  Googleフォームに登録した<strong>Googleアカウント（Gmail）</strong>でログインしてください。
                </p>
              </div>

              <button
                type="button"
                id="btnMainLoginScreen"
                class="btn btn-primary"
                style="width: 100%; padding: 13px 18px; font-size: 0.98rem; font-weight: 700; border-radius: 10px; display: flex; align-items: center; justify-content: center; gap: 10px; box-shadow: var(--shadow-md);"
              >
                <span>🔑</span>
                <span>Googleアカウントでログイン</span>
              </button>

              <div style="width: 100%; border-top: 1px solid var(--border); padding-top: 14px; font-size: 0.8rem; color: var(--text-muted); line-height: 1.5;">
                まだメンバー名簿への登録がお済みでない方は、<br />
                先に以下のフォームからご登録ください。<br />
                <a
                  href="${GOOGLE_FORM_URL}"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="display: inline-block; margin-top: 8px; color: var(--primary-dark); font-weight: 700; text-decoration: underline;"
                >
                  📝 教職の森 メンバー登録フォームを開く ↗
                </a>
              </div>
            </div>
          `;
          document.getElementById("btnMainLoginScreen")?.addEventListener("click", signInWithGoogle);
        }
        return;
      }

      if (titleEl) titleEl.textContent = "アクセス権限の確認中";
      if (countEl) countEl.textContent = "未承認";
      if (contentEl) {
        contentEl.innerHTML = `
          <div class="item-card" style="max-width: 460px; margin: 18px auto; padding: 26px 20px; text-align: center; align-items: center; gap: 14px;">
            <div style="font-size: 2.2rem;">🔒</div>
            <h3 style="color: var(--text-main); font-size: 1.1rem; font-weight: 800;">
              アカウント承認待ち
            </h3>
            <div style="background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; font-size: 0.82rem; color: var(--text-main); width: 100%; word-break: break-all;">
              ログイン中: <strong>${escapeHtml(state.currentUser.email || "")}</strong>
            </div>
            <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.6;">
              現在あなたのアカウントには役職がまだ割り当てられていません。<br />
              Googleフォームへの名簿登録、または代表・副代表・運営メンバー・開発管理者による承認が完了するまでお待ちください。
            </p>
            <div style="display: flex; flex-direction: column; gap: 8px; width: 100%; margin-top: 4px;">
              <button
                type="button"
                id="btnRetryRoleCheck"
                class="btn btn-primary"
                style="width: 100%; padding: 11px 16px; font-weight: 700;"
              >
                🔄 名簿と再照合して権限を確認する
              </button>
              <a
                href="${GOOGLE_FORM_URL}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-secondary"
                style="width: 100%; padding: 10px 16px; text-decoration: none; text-align: center;"
              >
                📝 Googleフォームで名簿登録する ↗
              </a>
              <button
                type="button"
                id="btnGuestLogout"
                class="btn btn-danger"
                style="width: 100%; padding: 10px 16px; margin-top: 4px;"
              >
                🚪 ログアウト（別のGoogleアカウントに切替）
              </button>
            </div>
          </div>
        `;
        document.getElementById("btnRetryRoleCheck")?.addEventListener("click", async e => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = "⏳ 照合中...";
          const role = await fetchCurrentUserRole();
          applyRbacUi(role);
          renderFilters();
          renderView();
          if (role === "guest") {
            alert("まだ名簿（スプレッドシート）上に同じメールアドレスが見つからないか、承認が完了していません。");
          }
        });
        document.getElementById("btnGuestLogout")?.addEventListener("click", signOutUser);
      }
      return;
    }
  }

  const fab = document.getElementById("btnAddRecord");
  const btnClearTab = document.getElementById("btnClearCurrentTab");
  const searchBox = document.querySelector(".search-box");
  const dynamicFilters = document.getElementById("dynamicFilters");

  if (btnClearTab) {
    btnClearTab.style.display = "none";
  }

  if (state.currentView === "members") {
    const canSearchMember = hasPermission(validRole, "membersSearch");
    const canCardViewMember = hasPermission(validRole, "membersCardView");
    const canAddMember = hasPermission(validRole, "membersAdd");
    const canEditMember = hasPermission(validRole, "membersEdit");

    if (searchBox) searchBox.style.display = canSearchMember ? "block" : "none";
    if (dynamicFilters) dynamicFilters.style.display = canSearchMember ? "flex" : "none";
    if (fab) fab.style.display = canAddMember ? "flex" : "none";

    const btnDirectAdd = document.getElementById("btnDirectAddMember");
    if (btnDirectAdd) btnDirectAdd.style.display = canAddMember ? "inline-block" : "none";

    const syncBanner = document.querySelector(".sync-banner");
    if (syncBanner) syncBanner.style.display = canAddMember || canEditMember ? "flex" : "none";

    document.querySelectorAll("[data-member-detail]").forEach(card => {
      card.style.display = canCardViewMember ? "flex" : "none";
    });
  } else if (state.currentView === "tasks") {
    const canSearchTask = hasPermission(validRole, "tasksSearch");
    const canEditTask = hasPermission(validRole, "tasksEdit");

    if (searchBox) searchBox.style.display = canSearchTask ? "block" : "none";
    if (dynamicFilters) dynamicFilters.style.display = canSearchTask ? "flex" : "none";
    if (fab) fab.style.display = canEditTask ? "flex" : "none";
    document.querySelectorAll("[data-quick-status]").forEach(sel => {
      sel.style.display = canEditTask ? "inline-block" : "none";
    });
  } else if (state.currentView === "events") {
    const canSearchEvent = hasPermission(validRole, "eventsSearch");
    const canCardViewEvent = hasPermission(validRole, "eventsCardView");
    const canEditEvent = hasPermission(validRole, "eventsEdit");

    if (searchBox) searchBox.style.display = canSearchEvent ? "block" : "none";
    if (dynamicFilters) dynamicFilters.style.display = canSearchEvent ? "flex" : "none";
    if (fab) fab.style.display = canEditEvent ? "flex" : "none";
    document.querySelectorAll("[data-event-detail]").forEach(card => {
      card.style.display = canCardViewEvent ? "flex" : "none";
    });
  } else if (state.currentView === "attendance") {
    const canInputAttendance = hasPermission(validRole, "attendanceInput");
    const canManageDates = hasPermission(validRole, "attendanceManageDates");
    if (fab) fab.style.display = canInputAttendance ? "flex" : "none";

    const btnAddMonthQuick = document.getElementById("btnAddMonthQuick");
    const btnManageDates = document.getElementById("btnManageDates");
    if (btnAddMonthQuick) btnAddMonthQuick.style.display = canManageDates ? "inline-block" : "none";
    if (btnManageDates) btnManageDates.style.display = canManageDates ? "inline-block" : "none";

    document.querySelectorAll("[data-bulk-member], [data-cell-member]").forEach(el => {
      el.style.pointerEvents = canInputAttendance ? "auto" : "none";
    });
  }

  const btnSwitchToEdit = document.getElementById("btnSwitchToEdit");
  const btnDeleteRecord = document.getElementById("btnDeleteRecord");
  if (state.modalMode === "memberDetail" && btnSwitchToEdit) {
    btnSwitchToEdit.style.display = hasPermission(validRole, "membersEdit") ? "inline-flex" : "none";
  } else if (state.modalMode === "eventDetail" && btnSwitchToEdit) {
    btnSwitchToEdit.style.display = hasPermission(validRole, "eventsEdit") ? "inline-flex" : "none";
  } else if (state.modalMode === "taskDetail") {
    const canEditTask = hasPermission(validRole, "tasksEdit");
    if (btnSwitchToEdit) btnSwitchToEdit.style.display = canEditTask ? "inline-flex" : "none";
    if (btnDeleteRecord) btnDeleteRecord.style.display = canEditTask ? "inline-block" : "none";
  }
}

const ROLE_OPTIONS = ["代表", "副代表", "運営メンバー", "在校生", "OB・OG", "開発管理者"];

const YEAR_OPTIONS = [
  "2023年度",
  "2024年度",
  "2025年度",
  "2026年度",
  "2027年度",
  "2028年度",
  "2029年度",
  "2030年度"
];

const SUBJECT_OPTIONS = [
  "中学校 社会",
  "高等学校 地理歴史",
  "高等学校 公民",
  "高等学校 情報",
  "高等学校 商業",
  "中学校 保健体育（第一種）",
  "高等学校 保健体育（第一種）",
  "中学校 保健体育（専修）",
  "高等学校 保健体育（専修）",
  "教員免許の取得を目指していない"
];

const STATUS_OPTIONS = ["未着手", "進行中", "保留", "完了"];
const EVENT_STATUS_OPTIONS = ["開催", "終了"];
const MARK_OPTIONS = ["◯", "△", "✕"];

function getTodayIsoString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getAutoEventStatus(ev) {
  if (!ev) return "開催";
  const todayIso = getTodayIsoString();
  if (ev.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(ev.eventDate) && ev.eventDate < todayIso) {
    ev.status = "終了";
  } else if (!ev.status || !EVENT_STATUS_OPTIONS.includes(ev.status) || (ev.eventDate && ev.eventDate >= todayIso)) {
    ev.status = "開催";
  }
  return ev.status;
}

function refreshAllEventStatuses(eventsList = []) {
  if (!Array.isArray(eventsList)) return;
  eventsList.forEach(ev => getAutoEventStatus(ev));
}

function generateUniqueId() {
  return Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

function generateSequentialId(prefix, count) {
  const numStr = "0000" + (count + 1);
  return prefix + numStr.slice(-4);
}

function generateNextTaskId(tasksList = []) {
  let maxNum = tasksList.length;
  tasksList.forEach(t => {
    const m = String(t.taskId || "").match(/^T(\d+)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });
  const numStr = "0000" + (maxNum + 1);
  return "T" + numStr.slice(-4);
}

function generateNextEventId(eventsList = []) {
  let maxNum = eventsList.length;
  eventsList.forEach(ev => {
    const m = String(ev.eventId || "").match(/^E(\d+)$/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  });
  const numStr = "0000" + (maxNum + 1);
  return "E" + numStr.slice(-4);
}

function formatDateLabelFromIso(isoDate, timeSuffix = "17:30〜") {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || "";
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const w = dayNames[dt.getDay()];
  return timeSuffix ? `${m}/${d} (${w}) ${timeSuffix}` : `${m}/${d} (${w})`;
}

function formatEventDateHtml(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return `<span style="color: var(--text-muted); font-weight: 600;">開催日未定</span>`;
  }
  const [y, m, d] = isoDate.split("-");
  return `<span class="date-num">${escapeHtml(y)}</span><span class="date-unit">年</span><span class="date-num">${escapeHtml(m)}</span><span class="date-unit">月</span><span class="date-num">${escapeHtml(d)}</span><span class="date-unit">日</span>`;
}

function inferIsoDateFromLabel(ym, dateLabel) {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return "";
  const [y, m] = ym.split("-").map(Number);
  const match = String(dateLabel || "").match(/(?:(\d{1,2})\s*\/\s*)?(\d{1,2})/);
  if (!match) return `${ym}-01`;
  const monthNum = match[1] ? Number(match[1]) : m;
  const dayNum = Number(match[2]);
  return `${y}-${String(monthNum).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
}

const DEFAULT_DB = {
  sheetSyncUrl: DEFAULT_SHEET_URL,
  lastSyncedAt: "",
  members: [
    {
      sysId: "m2301196",
      studentId: "2301196",
      name: "樋下田 大地",
      email: "",
      role: "開発管理者",
      admissionYear: "2023年度",
      discordName: "ひげた",
      subjects: ["高等学校 公民"]
    }
  ],
  tasks: [],
  events: [],
  monthlySchedules: {}
};

let db = loadDb();
let state = {
  currentView: "members",
  eventsLayout: "list",
  selectedMonth: getTodayIsoString().slice(0, 7),
  searchQuery: "",
  roleFilter: "ALL",
  yearFilter: "ALL",
  subjectFilter: "ALL",
  statusFilters: [...STATUS_OPTIONS],
  eventStatusFilters: [...EVENT_STATUS_OPTIONS],
  eventVisibilityFilter: "ALL",
  editingSysId: null,
  modalMode: "record",
  activeDbSheet: "members",
  userRole: supabaseClient ? "guest" : "developer",
  currentUser: null
};

function loadDb() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const fresh = structuredClone(DEFAULT_DB);
      reconcileEventsAndSchedules(fresh);
      return fresh;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.members)) parsed.members = structuredClone(DEFAULT_DB.members);
    if (!Array.isArray(parsed.tasks)) parsed.tasks = [];
    if (!Array.isArray(parsed.events)) parsed.events = [];
    if (!parsed.monthlySchedules || typeof parsed.monthlySchedules !== "object") {
      parsed.monthlySchedules = {};
    }
    if (!parsed.sheetSyncUrl) {
      parsed.sheetSyncUrl = DEFAULT_SHEET_URL;
    }
    reconcileEventsAndSchedules(parsed);
    return parsed;
  } catch (e) {
    const fallback = structuredClone(DEFAULT_DB);
    reconcileEventsAndSchedules(fallback);
    return fallback;
  }
}

function saveDb() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  updateAttendanceNotificationBadge();
  checkAndTriggerAdminPushNotifications(false);
  saveCloudDb();
}

// ==========================================================
// 「イベント」と「出欠調整」の双方向連携ロジック（運営限定フラグ対応）
// ==========================================================

function sortSheetDates(sheet) {
  if (!sheet || !Array.isArray(sheet.dates)) return;
  sheet.dates.sort((a, b) => {
    const isoA = a.isoDate || inferIsoDateFromLabel(sheet.monthKey, a.dateLabel);
    const isoB = b.isoDate || inferIsoDateFromLabel(sheet.monthKey, b.dateLabel);
    return isoA.localeCompare(isoB);
  });
}

function syncEventToMonthlySchedule(ev, previousEventDate = null, targetDb = db) {
  if (!ev || !ev.sysId) return;

  if (previousEventDate && previousEventDate !== ev.eventDate) {
    const oldYm = previousEventDate.slice(0, 7);
    const newYm = ev.eventDate ? ev.eventDate.slice(0, 7) : "";
    if (oldYm !== newYm && targetDb.monthlySchedules[oldYm]) {
      const oldSheet = targetDb.monthlySchedules[oldYm];
      oldSheet.dates = oldSheet.dates.filter(d => d.eventSysId !== ev.sysId);
    }
  }

  if (!ev.eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(ev.eventDate)) {
    removeEventFromMonthlySchedule(ev.sysId, targetDb);
    return;
  }

  const ym = ev.eventDate.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);

  if (!targetDb.monthlySchedules[ym]) {
    targetDb.monthlySchedules[ym] = {
      monthKey: ym,
      monthLabel: `${y}年${m}月`,
      dates: [],
      responses: {}
    };
  }

  const sheet = targetDb.monthlySchedules[ym];
  let dateEntry = sheet.dates.find(d => d.eventSysId === ev.sysId);
  if (!dateEntry) {
    dateEntry = sheet.dates.find(d => {
      const dIso = d.isoDate || inferIsoDateFromLabel(ym, d.dateLabel);
      return !d.eventSysId && dIso === ev.eventDate && d.title === ev.eventName;
    });
  }

  if (dateEntry) {
    const oldIso = dateEntry.isoDate || inferIsoDateFromLabel(ym, dateEntry.dateLabel);
    dateEntry.eventSysId = ev.sysId;
    dateEntry.isoDate = ev.eventDate;
    dateEntry.title = ev.eventName;
    dateEntry.adminOnly = Boolean(ev.adminOnly);
    if (oldIso !== ev.eventDate || !dateEntry.dateLabel) {
      dateEntry.dateLabel = formatDateLabelFromIso(ev.eventDate, "17:30〜");
    }
  } else {
    sheet.dates.push({
      dateId: "d_" + generateUniqueId(),
      isoDate: ev.eventDate,
      eventSysId: ev.sysId,
      dateLabel: formatDateLabelFromIso(ev.eventDate, "17:30〜"),
      title: ev.eventName,
      adminOnly: Boolean(ev.adminOnly)
    });
  }

  sortSheetDates(sheet);
}

function removeEventFromMonthlySchedule(eventSysId, targetDb = db) {
  if (!eventSysId || !targetDb.monthlySchedules) return;
  Object.values(targetDb.monthlySchedules).forEach(sheet => {
    if (!Array.isArray(sheet.dates)) return;
    const removedIds = sheet.dates
      .filter(d => d.eventSysId === eventSysId)
      .map(d => d.dateId);
    if (removedIds.length > 0) {
      sheet.dates = sheet.dates.filter(d => d.eventSysId !== eventSysId);
      if (sheet.responses) {
        Object.values(sheet.responses).forEach(resp => {
          removedIds.forEach(dId => {
            if (resp.marks) delete resp.marks[dId];
          });
        });
      }
    }
  });
}

function syncScheduleDateToEvents(ym, dateObj, targetDb = db) {
  if (!dateObj) return;
  if (!dateObj.isoDate) {
    dateObj.isoDate = inferIsoDateFromLabel(ym, dateObj.dateLabel);
  }
  if (!dateObj.dateLabel && dateObj.isoDate) {
    dateObj.dateLabel = formatDateLabelFromIso(dateObj.isoDate, "17:30〜");
  }

  if (dateObj.eventSysId) {
    const linked = targetDb.events.find(e => e.sysId === dateObj.eventSysId);
    if (linked) {
      linked.eventName = dateObj.title;
      if (dateObj.isoDate) linked.eventDate = dateObj.isoDate;
      if (typeof dateObj.adminOnly === "boolean") {
        linked.adminOnly = dateObj.adminOnly;
      } else {
        dateObj.adminOnly = Boolean(linked.adminOnly);
      }
      return linked;
    }
  }

  const sameEvent = targetDb.events.find(
    e => e.eventDate === dateObj.isoDate && e.eventName === dateObj.title
  );
  if (sameEvent) {
    dateObj.eventSysId = sameEvent.sysId;
    if (typeof dateObj.adminOnly === "boolean") {
      sameEvent.adminOnly = dateObj.adminOnly;
    } else {
      dateObj.adminOnly = Boolean(sameEvent.adminOnly);
    }
    return sameEvent;
  }

  const newEv = {
    sysId: "e_" + generateUniqueId(),
    eventId: generateNextEventId(targetDb.events),
    eventName: dateObj.title || "サークル活動",
    eventDate: dateObj.isoDate || "",
    adminOnly: Boolean(dateObj.adminOnly)
  };
  getAutoEventStatus(newEv);
  targetDb.events.push(newEv);
  dateObj.eventSysId = newEv.sysId;
  return newEv;
}

function syncMonthScheduleAndEvents(ym, targetDb = db) {
  const sheet = targetDb.monthlySchedules[ym];
  if (!sheet) return;

  sheet.dates.forEach(d => {
    syncScheduleDateToEvents(ym, d, targetDb);
  });

  targetDb.events.forEach(ev => {
    if (ev.eventDate && ev.eventDate.startsWith(ym + "-")) {
      syncEventToMonthlySchedule(ev, null, targetDb);
    }
  });

  sortSheetDates(sheet);
}

function reconcileEventsAndSchedules(targetDb = db) {
  if (!targetDb) return;
  if (!Array.isArray(targetDb.events)) targetDb.events = [];
  if (!targetDb.monthlySchedules) targetDb.monthlySchedules = {};

  Object.keys(targetDb.monthlySchedules).forEach(ym => {
    const sheet = targetDb.monthlySchedules[ym];
    if (!sheet || !Array.isArray(sheet.dates)) return;
    sheet.dates.forEach(d => {
      if (!d.isoDate) {
        d.isoDate = inferIsoDateFromLabel(ym, d.dateLabel);
      }
      if (!d.eventSysId) {
        const candidateEv = targetDb.events.find(
          e =>
            e.eventDate === d.isoDate &&
            !sheet.dates.some(other => other !== d && other.eventSysId === e.sysId)
        );
        if (candidateEv) {
          d.eventSysId = candidateEv.sysId;
          d.title = candidateEv.eventName;
          d.adminOnly = Boolean(candidateEv.adminOnly);
        } else {
          syncScheduleDateToEvents(ym, d, targetDb);
        }
      } else {
        const linkedEv = targetDb.events.find(e => e.sysId === d.eventSysId);
        if (linkedEv) {
          d.adminOnly = Boolean(linkedEv.adminOnly);
        }
      }
    });
  });

  targetDb.events.forEach(ev => {
    ev.adminOnly = Boolean(ev.adminOnly);
    getAutoEventStatus(ev);
    if (ev.eventDate) {
      syncEventToMonthlySchedule(ev, null, targetDb);
    }
  });
}

// ==========================================================
// Googleフォーム（回答先スプレッドシート / CSV）連携ロジック
// ==========================================================

function buildCsvExportUrl(rawUrl) {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return "";

  if (trimmed.includes("output=csv") || trimmed.includes("format=csv") || trimmed.includes("tqx=out:csv")) {
    return trimmed;
  }

  if (trimmed.includes("/spreadsheets/d/e/") && trimmed.includes("/pub")) {
    return trimmed.replace(/\/pubhtml.*$/, "/pub?output=csv").replace(/\/pub(\?.*)?$/, "/pub?output=csv");
  }

  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    const sheetId = match[1];
    const gidMatch = trimmed.match(/[#&?]gid=([0-9]+)/);
    const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : "";
    return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv${gidParam}`;
  }

  return trimmed;
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const clean = text.replace(/^\uFEFF/, "");

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const next = clean[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        row.push(cell.trim());
        cell = "";
      } else if (ch === "\r" && next === "\n") {
        row.push(cell.trim());
        rows.push(row);
        row = [];
        cell = "";
        i++;
      } else if (ch === "\n" || ch === "\r") {
        row.push(cell.trim());
        rows.push(row);
        row = [];
        cell = "";
      } else {
        cell += ch;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c !== ""));
}

function mergeMembersFromRows(rows) {
  if (!rows || rows.length < 2) {
    throw new Error("回答データ行がまだありません（Googleフォームで1件以上回答を送信してから同期してください）。");
  }

  const headers = rows[0].map(h => String(h ?? "").trim());
  const findCol = keywords =>
    headers.findIndex(h => keywords.some(k => h.includes(k)));

  const idxStudentId = findCol(["学籍番号"]);
  const idxName = findCol(["名前", "氏名"]);
  const idxEmail = findCol(["メールアドレス", "メール", "Email", "email"]);
  const idxYear = findCol(["入学年度"]);
  const idxDiscord = findCol(["Discord", "discord", "ユーザー名"]);
  const idxSubjects = findCol(["希望教科"]);
  const idxRole = findCol(["役職"]);

  if (idxName === -1 && idxStudentId === -1 && idxEmail === -1) {
    throw new Error("「学籍番号」「名前（氏名）」「メールアドレス」のいずれかの列が見つかりません。Googleフォームの回答先スプレッドシートかご確認ください。");
  }

  let addedCount = 0;
  let updatedCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const studentId = idxStudentId >= 0 ? String(r[idxStudentId] ?? "").trim() : "";
    const name = idxName >= 0 ? String(r[idxName] ?? "").trim() : "";
    const email = idxEmail >= 0 ? String(r[idxEmail] ?? "").trim().toLowerCase() : "";
    if (!studentId && !name && !email) continue;
    if (
      studentId === "学籍番号" ||
      name === "名前" ||
      name === "氏名" ||
      email === "メールアドレス"
    ) {
      continue;
    }

    let admissionYear = idxYear >= 0 ? String(r[idxYear] ?? "").trim() : "2026年度";
    if (admissionYear && !admissionYear.endsWith("年度")) {
      admissionYear = `${admissionYear}年度`;
    }
    const discordName = idxDiscord >= 0 ? String(r[idxDiscord] ?? "").trim() : "";
    const rawSubjects = idxSubjects >= 0 ? String(r[idxSubjects] ?? "").trim() : "";
    const subjects = rawSubjects
      ? rawSubjects.split(/\s*,\s*/).filter(Boolean)
      : [];
    const roleFromCsv = idxRole >= 0 ? String(r[idxRole] ?? "").trim() : "";

    const existing = db.members.find(
      m =>
        (studentId && m.studentId === studentId) ||
        (email && m.email && m.email.toLowerCase() === email) ||
        (!studentId && !email && m.name === name)
    );

    if (existing) {
      if (studentId) existing.studentId = studentId;
      if (name) existing.name = name;
      if (email) existing.email = email;
      if (admissionYear) existing.admissionYear = admissionYear;
      if (discordName) existing.discordName = discordName;
      if (subjects.length > 0) existing.subjects = subjects;
      if (roleFromCsv && ROLE_OPTIONS.includes(roleFromCsv)) {
        existing.role = roleFromCsv;
      }
      updatedCount++;
    } else {
      db.members.push({
        sysId: generateUniqueId(),
        studentId,
        name: name || "未設定",
        email,
        role: roleFromCsv && ROLE_OPTIONS.includes(roleFromCsv) ? roleFromCsv : "在校生",
        admissionYear: YEAR_OPTIONS.includes(admissionYear) ? admissionYear : "2026年度",
        discordName,
        subjects
      });
      addedCount++;
    }
  }

  db.lastSyncedAt = new Date().toLocaleString("ja-JP");
  saveDb();
  return { addedCount, updatedCount, totalRows: rows.length - 1 };
}

function mergeMembersFromCsvText(csvText) {
  const rows = parseCsvText(csvText);
  return mergeMembersFromRows(rows);
}

function loadGoogleSheetViaJsonp(rawUrl) {
  return new Promise((resolve, reject) => {
    const trimmed = (rawUrl || "").trim();
    const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch || idMatch[1] === "e") {
      reject(
        new Error(
          "「ウェブに公開」用のURL（/d/e/2PACX-...）ではなく、スプレッドシートを開いたときの通常のアドレスバーのURL（https://docs.google.com/spreadsheets/d/xxxx.../edit）を貼り付けてください。"
        )
      );
      return;
    }

    const sheetId = idMatch[1];
    const gidMatch = trimmed.match(/[#&?]gid=([0-9]+)/);
    const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : "";
    const cbName = "_gvizCallback_" + Date.now() + "_" + Math.floor(Math.random() * 10000);

    let settled = false;
    const script = document.createElement("script");

    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      try {
        delete window[cbName];
      } catch (_) {
        window[cbName] = undefined;
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          "スプレッドシートへの接続がタイムアウトしました。スプレッドシート右上の「共有」＞一般的なアクセスが「リンクを知っている全員（閲覧者）」になっているか確認してください。"
        )
      );
    }, 10000);

    const handleGvizResponse = response => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();

      if (!response || response.status === "error" || !response.table) {
        const msg = response?.errors?.[0]?.detailed_message || "データ取得に失敗しました。";
        reject(new Error(msg));
        return;
      }

      const cols = (response.table.cols || []).map(c => String(c?.label ?? "").trim());
      const bodyRows = (response.table.rows || []).map(r =>
        (r.c || []).map(cell => {
          if (!cell) return "";
          return String(cell.f ?? cell.v ?? "").trim();
        })
      );

      const hasColHeaders = cols.some(
        label =>
          label.includes("学籍番号") ||
          label.includes("名前") ||
          label.includes("氏名") ||
          label.includes("メール")
      );
      const allRows = hasColHeaders ? [cols, ...bodyRows] : bodyRows;
      resolve(allRows);
    };

    window[cbName] = handleGvizResponse;
    window.google = window.google || {};
    window.google.visualization = window.google.visualization || {};
    window.google.visualization.Query = window.google.visualization.Query || {};
    window.google.visualization.Query.setResponse = handleGvizResponse;

    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(
        new Error(
          "スプレッドシートを読み込めませんでした。スプレッドシート右上の「共有」ボタンから、一般的なアクセスを「リンクを知っている全員」に変更してください。"
        )
      );
    };

    script.src = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json${gidParam}&_=${Date.now()}`;
    document.body.appendChild(script);
  });
}

async function syncFromGoogleSheetUrl(rawUrl, silent = false) {
  const statusEl = document.getElementById("syncStatusMsg");
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return;

  if (statusEl) {
    statusEl.style.color = "var(--primary-dark)";
    statusEl.textContent = "⏳ スプレッドシートから最新回答を取得中...";
  }

  try {
    const rows = await loadGoogleSheetViaJsonp(trimmed);
    const result = mergeMembersFromRows(rows);
    db.sheetSyncUrl = trimmed;

    await syncMemberRolesFromSupabase();

    saveDb();
    renderFilters();
    renderView();

    if (statusEl) {
      statusEl.style.color = "#15803d";
      statusEl.textContent = `✅ 同期完了！ (新規追加: ${result.addedCount}名 / 更新: ${result.updatedCount}名 / 最終同期: ${db.lastSyncedAt})`;
    }
  } catch (err) {
    if (statusEl) {
      statusEl.style.color = "var(--danger)";
      statusEl.textContent = `⚠️ 同期エラー: ${err.message}`;
    } else if (!silent) {
      alert(`同期エラー: ${err.message}`);
    }
  }
}

function getRoleBadgeClass(role) {
  switch (role) {
    case "開発管理者": return "role-rep";
    case "代表": return "role-rep";
    case "副代表": return "role-subrep";
    case "運営メンバー": return "role-exec";
    case "在校生": return "role-student";
    case "OB・OG": return "role-alumni";
    default: return "";
  }
}

function getStatusBadgeClass(status) {
  switch (status) {
    case "未着手": return "status-not-started";
    case "進行中": return "status-in-progress";
    case "完了": return "status-completed";
    case "保留": return "status-on-hold";
    default: return "";
  }
}

function getEventStatusBadgeClass(status) {
  return status === "終了" ? "event-status-ended" : "event-status-active";
}

function getMarkClass(mark) {
  if (mark === "◯") return "mark-ok";
  if (mark === "△") return "mark-maybe";
  if (mark === "✕") return "mark-ng";
  return "mark-none";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// フィルタバー描画
function renderFilters() {
  const toolbar = document.querySelector(".toolbar-controls");
  const container = document.getElementById("dynamicFilters");

  if (state.currentView === "attendance") {
    toolbar.style.display = "none";
    return;
  }
  toolbar.style.display = "flex";

  if (state.currentView === "members") {
    container.innerHTML = `
      <select id="filterRole" class="filter-select" aria-label="役職で絞り込み">
        <option value="ALL">役職: すべて</option>
        ${ROLE_OPTIONS.map(r => `<option value="${r}" ${state.roleFilter === r ? "selected" : ""}>${r}</option>`).join("")}
      </select>
      <select id="filterYear" class="filter-select" aria-label="入学年度で絞り込み">
        <option value="ALL">入学年度: すべて</option>
        ${YEAR_OPTIONS.map(y => `<option value="${y}" ${state.yearFilter === y ? "selected" : ""}>${y}</option>`).join("")}
      </select>
      <select id="filterSubject" class="filter-select" aria-label="希望教科で絞り込み">
        <option value="ALL">希望教科: すべて</option>
        ${SUBJECT_OPTIONS.map(s => `<option value="${s}" ${state.subjectFilter === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <button type="button" class="btn-icon" id="btnDirectAddMember" title="Googleフォームを経由せず運営側で直接名簿に追加">
        ＋ 手動で直接追加
      </button>
    `;
    document.getElementById("filterRole").addEventListener("change", e => {
      state.roleFilter = e.target.value;
      renderView();
    });
    document.getElementById("filterYear").addEventListener("change", e => {
      state.yearFilter = e.target.value;
      renderView();
    });
    document.getElementById("filterSubject").addEventListener("change", e => {
      state.subjectFilter = e.target.value;
      renderView();
    });
    document.getElementById("btnDirectAddMember").addEventListener("click", () => {
      openFormModal(null);
    });
  } else if (state.currentView === "tasks") {
    const allChecked = state.statusFilters.length === STATUS_OPTIONS.length;
    container.innerHTML = `
      <div class="multi-filter-group" role="group" aria-label="進捗で絞り込み（複数選択可）">
        <span class="multi-filter-label">進捗（複数選択可）:</span>
        ${STATUS_OPTIONS.map(s => {
          const isChecked = state.statusFilters.includes(s);
          return `
            <label class="status-chip-label ${isChecked ? "checked" : ""}">
              <input type="checkbox" name="taskStatusFilter" value="${s}" ${isChecked ? "checked" : ""} />
              <span>${s}</span>
            </label>
          `;
        }).join("")}
        <button type="button" class="btn-icon" id="btnToggleAllStatus" style="padding: 4px 9px; font-size: 0.76rem;">
          ${allChecked ? "全解除" : "すべて選択"}
        </button>
      </div>
    `;
    container.querySelectorAll('input[name="taskStatusFilter"]').forEach(cb => {
      cb.addEventListener("change", () => {
        state.statusFilters = Array.from(
          container.querySelectorAll('input[name="taskStatusFilter"]:checked')
        ).map(el => el.value);
        renderFilters();
        renderView();
      });
    });
    document.getElementById("btnToggleAllStatus").addEventListener("click", () => {
      if (state.statusFilters.length === STATUS_OPTIONS.length) {
        state.statusFilters = [];
      } else {
        state.statusFilters = [...STATUS_OPTIONS];
      }
      renderFilters();
      renderView();
    });
  } else if (state.currentView === "events") {
    const allChecked = state.eventStatusFilters.length === EVENT_STATUS_OPTIONS.length;
    const isAdmin = isAdminRole(state.userRole);
    container.innerHTML = `
      <div class="multi-filter-group" role="group" aria-label="ステータスで絞り込み（複数選択可）">
        <span class="multi-filter-label">ステータス:</span>
        ${EVENT_STATUS_OPTIONS.map(s => {
          const isChecked = state.eventStatusFilters.includes(s);
          return `
            <label class="status-chip-label ${isChecked ? "checked" : ""}">
              <input type="checkbox" name="eventStatusFilter" value="${s}" ${isChecked ? "checked" : ""} />
              <span>${s}</span>
            </label>
          `;
        }).join("")}
        <button type="button" class="btn-icon" id="btnToggleAllEventStatus" style="padding: 4px 9px; font-size: 0.76rem;">
          ${allChecked ? "全解除" : "すべて選択"}
        </button>
      </div>
      ${isAdmin ? `
        <select id="filterEventVisibility" class="filter-select" aria-label="公開範囲で絞り込み" style="margin-left: auto;">
          <option value="ALL" ${state.eventVisibilityFilter === "ALL" ? "selected" : ""}>公開範囲: すべて</option>
          <option value="PUBLIC" ${state.eventVisibilityFilter === "PUBLIC" ? "selected" : ""}>🌐 全員公開のみ</option>
          <option value="ADMIN_ONLY" ${state.eventVisibilityFilter === "ADMIN_ONLY" ? "selected" : ""}>🔒 運営限定のみ</option>
        </select>
      ` : ""}
    `;
    container.querySelectorAll('input[name="eventStatusFilter"]').forEach(cb => {
      cb.addEventListener("change", () => {
        state.eventStatusFilters = Array.from(
          container.querySelectorAll('input[name="eventStatusFilter"]:checked')
        ).map(el => el.value);
        renderFilters();
        renderView();
      });
    });
    document.getElementById("btnToggleAllEventStatus").addEventListener("click", () => {
      if (state.eventStatusFilters.length === EVENT_STATUS_OPTIONS.length) {
        state.eventStatusFilters = [];
      } else {
        state.eventStatusFilters = [...EVENT_STATUS_OPTIONS];
      }
      renderFilters();
      renderView();
    });
    document.getElementById("filterEventVisibility")?.addEventListener("click", e => e.stopPropagation());
    document.getElementById("filterEventVisibility")?.addEventListener("change", e => {
      state.eventVisibilityFilter = e.target.value;
      renderView();
    });
  } else {
    container.innerHTML = "";
  }
}

function deleteRecordById(viewType, sysId) {
  if (viewType === "members") {
    db.members = db.members.filter(m => m.sysId !== sysId);
    Object.values(db.monthlySchedules || {}).forEach(sheet => {
      if (sheet.responses && sheet.responses[sysId]) {
        delete sheet.responses[sysId];
      }
    });
  } else if (viewType === "tasks") {
    db.tasks = db.tasks.filter(t => t.sysId !== sysId);
  } else if (viewType === "events") {
    db.events = db.events.filter(ev => ev.sysId !== sysId);
    removeEventFromMonthlySchedule(sysId);
  }
  saveDb();
}

// メインビューの描画
function renderView() {
  const titleEl = document.getElementById("currentViewTitle");
  const countEl = document.getElementById("currentViewCount");
  const fabLabel = document.getElementById("fabLabel");
  const eventsToggleWrap = document.getElementById("eventsViewToggleWrap");
  const btnClearTab = document.getElementById("btnClearCurrentTab");
  const contentEl = document.getElementById("viewContent");
  const q = state.searchQuery.trim().toLowerCase();

  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === state.currentView);
  });

  updateAttendanceNotificationBadge();
  updateHeaderNotificationBell();

  if (btnClearTab) {
    btnClearTab.style.display = "none";
  }

  if (state.currentView === "members") {
    titleEl.textContent = "メンバー";
    fabLabel.textContent = "メンバー追加（Googleフォーム ↗）";
    eventsToggleWrap.style.display = "none";

    const filtered = db.members.filter(m => {
      const subjectsArr = Array.isArray(m.subjects) ? m.subjects : [];
      const matchSearch =
        !q ||
        (m.studentId || "").toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        (m.email || "").toLowerCase().includes(q) ||
        m.role.toLowerCase().includes(q) ||
        String(m.admissionYear).toLowerCase().includes(q) ||
        (m.discordName || "").toLowerCase().includes(q) ||
        subjectsArr.some(s => s.toLowerCase().includes(q));

      const matchRole = state.roleFilter === "ALL" || m.role === state.roleFilter;
      const matchYear = state.yearFilter === "ALL" || m.admissionYear === state.yearFilter;
      const matchSubject = state.subjectFilter === "ALL" || subjectsArr.includes(state.subjectFilter);
      return matchSearch && matchRole && matchYear && matchSubject;
    });

    countEl.textContent = `${filtered.length}名`;

    const syncBannerHtml = `
      <div class="sync-banner">
        <div>
          <strong>🔗 Googleフォーム & クラウド連携:</strong>
          ${db.sheetSyncUrl
            ? `連携済み（最終同期: ${escapeHtml(db.lastSyncedAt || "未実行")}）`
            : `未設定 — Googleフォームの回答を自動反映するには「連携設定」から回答先スプレッドシートURLまたはCSVを登録してください`
          }
        </div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
          ${db.sheetSyncUrl
            ? `<button type="button" class="btn btn-primary" id="btnBannerSyncNow" style="padding: 5px 11px; font-size: 0.78rem;">🔄 最新回答を同期</button>`
            : ""
          }
          <button type="button" class="btn btn-secondary" id="btnBannerOpenSync" style="padding: 5px 11px; font-size: 0.78rem;">
            ⚙️ フォーム連携設定 / CSV取込
          </button>
        </div>
      </div>
    `;

    if (filtered.length === 0) {
      contentEl.innerHTML = `
        ${syncBannerHtml}
        <div class="empty-state">
          <p style="margin-bottom: 12px;">登録されているメンバーがいません。右下の「<strong>＋ メンバー追加（Googleフォーム ↗）</strong>」からGoogleフォームへ移動して登録できます。</p>
          <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
            <a href="${GOOGLE_FORM_URL}" target="_blank" rel="noopener noreferrer" class="btn btn-primary" style="text-decoration: none;">
              📝 Googleフォームを開いて登録する ↗
            </a>
            <button type="button" class="btn btn-secondary" id="btnEmptyDirectAdd">
              ＋ アプリ内に直接追加（運営管理用）
            </button>
          </div>
        </div>
      `;
      document.getElementById("btnEmptyDirectAdd")?.addEventListener("click", () => openFormModal(null));
      document.getElementById("btnBannerOpenSync")?.addEventListener("click", openSyncModal);
      document.getElementById("btnBannerSyncNow")?.addEventListener("click", () => syncFromGoogleSheetUrl(db.sheetSyncUrl, false));
      applyRbacUi(state.userRole);
      return;
    }

    contentEl.innerHTML = `
      ${syncBannerHtml}
      <div class="card-grid">
        ${filtered.map(m => `
          <article class="item-card item-card-clickable" data-member-detail="${escapeHtml(m.sysId)}" role="button" tabindex="0" aria-label="${escapeHtml(m.name)}の詳細を表示">
            <div class="item-main">
              <div class="avatar">${escapeHtml(m.name.slice(0, 1))}</div>
              <div class="item-info">
                <div class="item-title">${escapeHtml(m.name)}</div>
                <div class="item-meta">
                  <span class="badge ${getRoleBadgeClass(m.role)}">${escapeHtml(m.role)}</span>
                  ${m.discordName ? `<span class="badge badge-discord" title="Discordユーザー名">💬 ${escapeHtml(m.discordName)}</span>` : ""}
                </div>
              </div>
              <span class="card-chevron" aria-hidden="true">›</span>
            </div>
          </article>
        `).join("")}
      </div>
    `;
    document.getElementById("btnBannerOpenSync")?.addEventListener("click", openSyncModal);
    document.getElementById("btnBannerSyncNow")?.addEventListener("click", () => syncFromGoogleSheetUrl(db.sheetSyncUrl, false));
    contentEl.querySelectorAll("[data-member-detail]").forEach(card => {
      card.addEventListener("click", () => openMemberDetailModal(card.dataset.memberDetail));
      card.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openMemberDetailModal(card.dataset.memberDetail);
        }
      });
    });
  } else if (state.currentView === "tasks") {
    titleEl.textContent = "タスク";
    fabLabel.textContent = "タスク追加";
    eventsToggleWrap.style.display = "none";

    const filtered = db.tasks.filter(t => {
      const jpDue =
        t.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)
          ? t.dueDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日")
          : "";
      const matchSearch =
        !q ||
        t.taskId.toLowerCase().includes(q) ||
        t.taskName.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q) ||
        (t.assignee || "").toLowerCase().includes(q) ||
        (t.dueDate || "").toLowerCase().includes(q) ||
        jpDue.toLowerCase().includes(q) ||
        (t.memo || "").toLowerCase().includes(q);
      const matchStatus = state.statusFilters.includes(t.status);
      return matchSearch && matchStatus;
    });

    countEl.textContent = `${filtered.length}件`;

    if (filtered.length === 0) {
      contentEl.innerHTML = `<div class="empty-state">登録されているタスクはありません。右下の「＋ タスク追加」から新しいタスクを登録できます（Supabaseに自動保存されます）。</div>`;
      applyRbacUi(state.userRole);
      return;
    }

    contentEl.innerHTML = `
      <div class="list-stack">
        ${filtered.map(t => {
          const hasSubMeta = Boolean(t.assignee || t.dueDate || t.memo);
          const formattedDue =
            t.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate)
              ? t.dueDate.replace(/^(\d{4})-0?(\d{1,2})-0?(\d{1,2})$/, "$1年$2月$3日")
              : t.dueDate || "";
          const diffDays = t.status !== "完了" && t.dueDate ? getDaysUntilIsoDate(t.dueDate) : null;
          const isReminderTarget = diffDays !== null && REMINDER_TARGET_DAYS.includes(diffDays);
          return `
            <article class="list-row item-card-clickable" data-task-row="${escapeHtml(t.sysId)}" style="${isReminderTarget ? "border-left: 4px solid #dc2626;" : ""}">
              <div class="item-main" style="flex-direction: column; align-items: flex-start; gap: 4px;">
                <div class="task-parallel-row">
                  <span class="task-id-large">${escapeHtml(t.taskId)}</span>
                  <span class="badge task-status-large ${getStatusBadgeClass(t.status)}">${escapeHtml(t.status)}</span>
                  ${isReminderTarget
                    ? `<span class="badge" style="background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;">🔔 期日まであと${diffDays}日</span>`
                    : ""
                  }
                  <span class="task-name-large">${escapeHtml(t.taskName)}</span>
                </div>
                ${hasSubMeta ? `
                  <div class="task-sub-meta">
                    ${t.assignee ? `<span>👤 担当: <strong>${escapeHtml(t.assignee)}</strong></span>` : ""}
                    ${formattedDue ? `<span>⏰ 期限: <strong>${escapeHtml(formattedDue)}</strong></span>` : ""}
                    ${t.memo ? `<span>📝 ${escapeHtml(t.memo.length > 35 ? t.memo.slice(0, 35) + "…" : t.memo)}</span>` : ""}
                  </div>
                ` : ""}
              </div>
              <div class="item-actions">
                <select class="status-quick-select" data-quick-status="${escapeHtml(t.sysId)}" aria-label="進捗変更">
                  ${STATUS_OPTIONS.map(s => `<option value="${s}" ${t.status === s ? "selected" : ""}>${s}</option>`).join("")}
                </select>
                <button type="button" class="btn-icon" data-task-detail="${escapeHtml(t.sysId)}" style="font-weight: 700; color: var(--primary-dark); border-color: #a7f3d0; background: #ecfdf5;">
                  📄 詳細
                </button>
              </div>
            </article>
          `;
        }).join("")}
      </div>
    `;
  } else if (state.currentView === "events") {
    titleEl.textContent = "イベント";
    fabLabel.textContent = "イベント追加";
    eventsToggleWrap.style.display = "block";

    refreshAllEventStatuses(db.events);
    const isAdmin = isAdminRole(state.userRole);

    const filtered = db.events.filter(ev => {
      if (ev.adminOnly && !isAdmin) return false;

      if (isAdmin) {
        if (state.eventVisibilityFilter === "PUBLIC" && ev.adminOnly) return false;
        if (state.eventVisibilityFilter === "ADMIN_ONLY" && !ev.adminOnly) return false;
      }

      const evStatus = getAutoEventStatus(ev);
      const jpDate =
        ev.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(ev.eventDate)
          ? ev.eventDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日")
          : "";
      const visibilityLabel = ev.adminOnly ? "運営限定" : "全員公開";
      const matchSearch =
        !q ||
        ev.eventId.toLowerCase().includes(q) ||
        ev.eventName.toLowerCase().includes(q) ||
        (ev.eventDate || "").toLowerCase().includes(q) ||
        jpDate.toLowerCase().includes(q) ||
        evStatus.toLowerCase().includes(q) ||
        visibilityLabel.toLowerCase().includes(q);
      const matchStatus = state.eventStatusFilters.includes(evStatus);
      return matchSearch && matchStatus;
    });

    countEl.textContent = `${filtered.length}件`;

    if (filtered.length === 0) {
      contentEl.innerHTML = `<div class="empty-state">登録されているイベント企画はありません。右下の「＋ イベント追加」または「出欠調整」タブからイベントを登録できます（Supabaseに自動保存されます）。</div>`;
      applyRbacUi(state.userRole);
      return;
    }

    const renderEventExtraBadges = ev => {
      const badges = [];
      if (ev.adminOnly) {
        badges.push(`<span class="badge" style="background: #fef3c7; color: #92400e; border: 1px solid #fde68a;">🔒 運営限定</span>`);
      }
      if (isAdmin && ev.eventDate) {
        const diff = getDaysUntilIsoDate(ev.eventDate);
        if (diff !== null && REMINDER_TARGET_DAYS.includes(diff)) {
          badges.push(`<span class="badge" style="background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5;">🔔 ${diff}日後に全体リマインド</span>`);
        }
      }
      return badges.join("");
    };

    if (state.eventsLayout === "deck") {
      contentEl.innerHTML = `
        <div class="card-grid">
          ${filtered.map(ev => {
            const evStatus = getAutoEventStatus(ev);
            return `
              <article class="item-card item-card-clickable" data-event-detail="${escapeHtml(ev.sysId)}" role="button" tabindex="0" style="${ev.adminOnly ? "border-left: 4px solid #d97706;" : ""}" aria-label="${escapeHtml(ev.eventName)}の詳細を表示">
                <div class="item-main" style="flex-direction: column; align-items: flex-start; gap: 8px; width: 100%;">
                  <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                      <span class="badge badge-id">${escapeHtml(ev.eventId)}</span>
                      <span class="badge ${getEventStatusBadgeClass(evStatus)}">${escapeHtml(evStatus)}</span>
                      ${renderEventExtraBadges(ev)}
                    </div>
                    <span class="card-chevron" aria-hidden="true">›</span>
                  </div>
                  <div class="event-parallel-row">
                    <span class="event-date-large">
                      ${formatEventDateHtml(ev.eventDate)}
                    </span>
                    <span class="event-name-large">${escapeHtml(ev.eventName)}</span>
                  </div>
                </div>
              </article>
            `;
          }).join("")}
        </div>
      `;
    } else {
      contentEl.innerHTML = `
        <div class="list-stack">
          ${filtered.map(ev => {
            const evStatus = getAutoEventStatus(ev);
            return `
              <article class="list-row item-card-clickable" data-event-detail="${escapeHtml(ev.sysId)}" role="button" tabindex="0" style="${ev.adminOnly ? "border-left: 4px solid #d97706;" : ""}" aria-label="${escapeHtml(ev.eventName)}の詳細を表示">
                <div class="item-main" style="flex-direction: column; align-items: flex-start; gap: 8px; width: 100%;">
                  <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                      <span class="badge badge-id">${escapeHtml(ev.eventId)}</span>
                      <span class="badge ${getEventStatusBadgeClass(evStatus)}">${escapeHtml(evStatus)}</span>
                      ${renderEventExtraBadges(ev)}
                    </div>
                    <span class="card-chevron" aria-hidden="true">›</span>
                  </div>
                  <div class="event-parallel-row">
                    <span class="event-date-large">
                      ${formatEventDateHtml(ev.eventDate)}
                    </span>
                    <span class="event-name-large">${escapeHtml(ev.eventName)}</span>
                  </div>
                </div>
              </article>
            `;
          }).join("")}
        </div>
      `;
    }
    contentEl.querySelectorAll("[data-event-detail]").forEach(card => {
      card.addEventListener("click", () => openEventDetailModal(card.dataset.eventDetail));
      card.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openEventDetailModal(card.dataset.eventDetail);
        }
      });
    });
  } else if (state.currentView === "attendance") {
    renderAttendanceView();
    return;
  }

  contentEl.querySelectorAll("[data-task-detail]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      openTaskDetailModal(btn.dataset.taskDetail);
    });
  });

  contentEl.querySelectorAll("[data-task-row]").forEach(row => {
    row.addEventListener("click", e => {
      if (e.target.closest("[data-quick-status]") || e.target.closest("[data-task-detail]")) return;
      openTaskDetailModal(row.dataset.taskRow);
    });
  });

  contentEl.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => openFormModal(btn.dataset.edit));
  });

  contentEl.querySelectorAll("[data-delete-direct]").forEach(btn => {
    btn.addEventListener("click", () => {
      const sysId = btn.dataset.deleteDirect;
      const label = btn.dataset.deleteLabel || "このデータ";
      if (!confirm(`「${label}」を削除してもよろしいですか？`)) return;
      deleteRecordById(state.currentView, sysId);
      renderView();
    });
  });

  contentEl.querySelectorAll("[data-quick-status]").forEach(sel => {
    sel.addEventListener("click", e => e.stopPropagation());
    sel.addEventListener("change", e => {
      const sysId = sel.dataset.quickStatus;
      const target = db.tasks.find(t => t.sysId === sysId);
      if (target) {
        target.status = e.target.value;
        saveDb();
        renderView();
      }
    });
  });

  contentEl.querySelectorAll("[data-goto-attendance]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetYm = btn.dataset.gotoAttendance;
      if (targetYm && db.monthlySchedules[targetYm]) {
        state.selectedMonth = targetYm;
      }
      state.currentView = "attendance";
      renderFilters();
      renderView();
    });
  });

  applyRbacUi(state.userRole);
}

// 「月別出欠調整」ビューの描画
function renderAttendanceView() {
  const titleEl = document.getElementById("currentViewTitle");
  const countEl = document.getElementById("currentViewCount");
  const fabLabel = document.getElementById("fabLabel");
  const eventsToggleWrap = document.getElementById("eventsViewToggleWrap");
  const contentEl = document.getElementById("viewContent");

  titleEl.textContent = "月別出欠調整";
  fabLabel.textContent = "自分の出欠を一括入力・変更";
  eventsToggleWrap.style.display = "none";

  updateAttendanceNotificationBadge();

  const monthKeys = Object.keys(db.monthlySchedules).sort();
  const unansweredMonths = getUnansweredMonthsForCurrentUser();

  if (!db.monthlySchedules[state.selectedMonth] && monthKeys.length > 0) {
    state.selectedMonth = unansweredMonths[0] || monthKeys[0];
  }
  const sheet = db.monthlySchedules[state.selectedMonth];

  if (!sheet || monthKeys.length === 0) {
    countEl.textContent = "0日程";
    contentEl.innerHTML = `
      <div class="attendance-top-bar">
        <div class="month-selector-group">
          <button type="button" class="btn btn-primary" id="btnAddMonthQuick">
            ＋ 最初の対象月（出欠表）を作成する
          </button>
        </div>
      </div>
      <div class="empty-state">
        まだ出欠調整の対象月が作成されていません。<br />
        上の「<strong>＋ 最初の対象月（出欠表）を作成する</strong>」ボタン、または「イベント」タブでイベントを追加すると出欠表が自動生成されます。
      </div>
    `;
    document.getElementById("btnAddMonthQuick")?.addEventListener("click", () => {
      openAddMonthModal();
    });
    applyRbacUi(state.userRole);
    return;
  }

  const dates = getVisibleDatesForRole(sheet, state.userRole);
  const responses = sheet.responses || {};
  const myMember = getCurrentLoggedInMember();
  const isAdmin = isAdminRole(state.userRole);

  const answeredCount = db.members.filter(m => isMonthAnsweredByMember(sheet, m.sysId)).length;
  countEl.textContent = `回答 ${answeredCount}/${db.members.length}名`;

  let maxOkCount = 0;
  const dateStats = dates.map(d => {
    let ok = 0, maybe = 0, ng = 0;
    db.members.forEach(m => {
      if (d.adminOnly && !isAdminRole(m.role)) return;
      const mark = responses[m.sysId]?.marks?.[d.dateId];
      if (mark === "◯") ok++;
      else if (mark === "△") maybe++;
      else if (mark === "✕") ng++;
    });
    if (ok > maxOkCount) maxOkCount = ok;
    return { ...d, ok, maybe, ng };
  });

  const unansweredBannerHtml =
    unansweredMonths.length > 0
      ? `
        <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: var(--radius); padding: 10px 14px; margin-bottom: 12px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; font-size: 0.83rem; color: #991b1b;">
          <div>
            <strong>🔴 未回答の出欠表があります（${unansweredMonths.length}件）:</strong>
            ${unansweredMonths
              .map(ym => {
                const lb = db.monthlySchedules[ym]?.monthLabel || ym;
                return `<button type="button" data-jump-unanswered="${escapeHtml(ym)}" style="background: ${ym === state.selectedMonth ? "#dc2626" : "#fff"}; color: ${ym === state.selectedMonth ? "#fff" : "#dc2626"}; border: 1px solid #fca5a5; border-radius: 999px; padding: 2px 10px; font-size: 0.78rem; font-weight: 700; margin-left: 4px; cursor: pointer;">${escapeHtml(lb)}</button>`;
              })
              .join("")}
          </div>
          ${unansweredMonths.includes(state.selectedMonth)
            ? `<button type="button" class="btn btn-primary" id="btnBannerAnswerNow" style="background: #dc2626; padding: 5px 12px; font-size: 0.78rem;">✍️ この月の出欠を今すぐ回答</button>`
            : ""
          }
        </div>
      `
      : "";

  contentEl.innerHTML = `
    ${unansweredBannerHtml}

    <div class="attendance-top-bar">
      <div class="month-selector-group">
        <label for="monthSelect" style="font-weight: 700; font-size: 0.9rem;">📅 対象月:</label>
        <select id="monthSelect" class="month-select">
          ${monthKeys.map(k => {
            const mSheet = db.monthlySchedules[k];
            const visibleCount = getVisibleDatesForRole(mSheet, state.userRole).length;
            const isUnanswered = unansweredMonths.includes(k);
            const statusSuffix = myMember && visibleCount > 0
              ? (isUnanswered ? " 🔴未回答" : " ✓回答済")
              : "";
            return `<option value="${escapeHtml(k)}" ${k === state.selectedMonth ? "selected" : ""}>${escapeHtml(mSheet.monthLabel)}（${visibleCount}日程）${statusSuffix}</option>`;
          }).join("")}
        </select>
        <button type="button" class="btn-icon" id="btnAddMonthQuick" style="font-weight: 700; color: var(--primary-dark); border-color: var(--primary);">
          ＋ 対象月を追加
        </button>
        <button type="button" class="btn-icon" id="btnManageDates">⚙️ 候補日の追加・削除</button>
      </div>
    </div>

    <div style="margin-bottom: 10px; font-size: 0.82rem; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 12px; align-items: center;">
      <span>💡 <strong>使い方:</strong> 右下の「<strong>＋ 自分の出欠を一括入力・変更</strong>」ボタンを押すと、ログイン情報から自動的に自分が割り当てられて一括登録できます。</span>
      ${maxOkCount > 0 ? `<span style="background:#d1fae5; color:#065f46; padding:2px 8px; border-radius:6px; font-weight:700;">★ 緑色の行＝参加可能（◯）が最も多い日程</span>` : ""}
    </div>

    <div class="matrix-card">
      <div class="matrix-scroll">
        <table class="matrix-table">
          <thead>
            <tr>
              <th class="col-date-label">日程 / 活動内容</th>
              <th>◯</th>
              <th>△</th>
              <th>✕</th>
              ${db.members.map(m => {
                const isMe = myMember && m.sysId === myMember.sysId;
                return `
                  <th style="${isMe ? "background: #ecfdf5;" : ""}">
                    <button
                      type="button"
                      class="member-col-btn"
                      data-bulk-member="${escapeHtml(m.sysId)}"
                      title="${isMe ? "クリックして自分の出欠を一括変更" : isAdmin ? `クリックして${escapeHtml(m.name)}さんの出欠を一括変更（管理者）` : escapeHtml(m.name)}"
                      style="${!isMe && !isAdmin ? "text-decoration: none; cursor: default; color: var(--text-main);" : ""}"
                    >
                      ${escapeHtml(m.name)}${isMe ? " (自分)" : ""}
                    </button>
                    <div style="font-size: 0.68rem; color: var(--text-muted); font-weight: 500;">${escapeHtml(m.role)}</div>
                  </th>
                `;
              }).join("")}
            </tr>
          </thead>
          <tbody>
            ${dateStats.map(d => {
              const isBest = maxOkCount > 0 && d.ok === maxOkCount;
              return `
                <tr class="${isBest ? "best-date-row" : ""}">
                  <td class="col-date-label">
                    <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                      <span>${isBest ? "★ " : ""}${escapeHtml(d.dateLabel)}</span>
                      ${d.adminOnly ? `<span class="badge" style="background: #fef3c7; color: #92400e; border: 1px solid #fde68a; font-size: 0.68rem; padding: 1px 6px;">🔒 運営限定</span>` : ""}
                    </div>
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 400;">${escapeHtml(d.title)}</div>
                  </td>
                  <td><span class="count-pill count-ok">${d.ok}</span></td>
                  <td><span class="count-pill count-maybe">${d.maybe}</span></td>
                  <td><span class="count-pill count-ng">${d.ng}</span></td>
                  ${db.members.map(m => {
                    if (d.adminOnly && !isAdminRole(m.role)) {
                      return `<td style="background: #f8fafc; color: #cbd5e1; font-size: 0.72rem;" title="運営メンバー限定イベントのため対象外">対象外</td>`;
                    }
                    const mark = responses[m.sysId]?.marks?.[d.dateId] || "-";
                    const isMe = myMember && m.sysId === myMember.sysId;
                    const canTapCell = isMe || isAdmin;
                    return `
                      <td
                        class="mark-cell ${getMarkClass(mark)}"
                        data-cell-member="${escapeHtml(m.sysId)}"
                        data-cell-date="${escapeHtml(d.dateId)}"
                        style="${!canTapCell ? "cursor: default;" : ""}"
                        title="${canTapCell ? `タップして ${escapeHtml(m.name)} さんの ${escapeHtml(d.dateLabel)} の出欠を切替` : ""}"
                      >
                        ${escapeHtml(mark)}
                      </td>
                    `;
                  }).join("")}
                </tr>
              `;
            }).join("")}
            <tr style="background: #fafafa;">
              <td class="col-date-label" style="font-weight: 700; color: var(--text-muted);">💬 ひとことコメント</td>
              <td colspan="3" style="color: var(--text-muted); font-size: 0.75rem;">-</td>
              ${db.members.map(m => {
                const comment = responses[m.sysId]?.comment || "";
                return `<td style="font-size: 0.76rem; color: var(--text-muted); max-width: 140px; white-space: normal; min-width: 110px;">${escapeHtml(comment || "—")}</td>`;
              }).join("")}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("monthSelect").addEventListener("change", e => {
    state.selectedMonth = e.target.value;
    renderAttendanceView();
  });

  contentEl.querySelectorAll("[data-jump-unanswered]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.selectedMonth = btn.dataset.jumpUnanswered;
      renderAttendanceView();
    });
  });

  document.getElementById("btnBannerAnswerNow")?.addEventListener("click", () => {
    openBulkAttendanceModal(null);
  });

  contentEl.querySelectorAll("[data-bulk-member]").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetSysId = btn.dataset.bulkMember;
      const isMe = myMember && targetSysId === myMember.sysId;
      if (!isMe && !isAdmin) return;
      openBulkAttendanceModal(targetSysId);
    });
  });

  contentEl.querySelectorAll("[data-cell-member]").forEach(cell => {
    cell.addEventListener("click", () => {
      const mId = cell.dataset.cellMember;
      const isMe = myMember && mId === myMember.sysId;
      if (!isMe && !isAdmin) return;

      const dId = cell.dataset.cellDate;
      if (!sheet.responses[mId]) {
        sheet.responses[mId] = { marks: {}, comment: "" };
      }
      const current = sheet.responses[mId].marks[dId] || "-";
      const next =
        current === "-" ? "◯" :
        current === "◯" ? "△" :
        current === "△" ? "✕" : "◯";
      sheet.responses[mId].marks[dId] = next;
      saveDb();
      renderAttendanceView();
    });
  });

  document.getElementById("btnAddMonthQuick").addEventListener("click", () => {
    openAddMonthModal();
  });

  document.getElementById("btnManageDates").addEventListener("click", () => {
    openManageDatesModal();
  });

  applyRbacUi(state.userRole);
}

function generateWeekdayDatesForMonth(year, month, targetDaysOfWeek = [3], defaultTime = "17:30〜", defaultTitle = "定例活動・模擬授業会") {
  const daysArray = Array.isArray(targetDaysOfWeek) ? targetDaysOfWeek.map(Number) : [Number(targetDaysOfWeek)];
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const result = [];
  const date = new Date(year, month - 1, 1);
  while (date.getMonth() === month - 1) {
    if (daysArray.includes(date.getDay())) {
      const d = date.getDate();
      const w = dayNames[date.getDay()];
      const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      result.push({
        dateId: "d_" + generateUniqueId(),
        isoDate,
        dateLabel: `${month}/${d} (${w}) ${defaultTime}`,
        title: defaultTitle,
        adminOnly: false
      });
    }
    date.setDate(date.getDate() + 1);
  }
  return result;
}

function resetFormModalButtons(isDetailMode = false) {
  const btnSwitchToEdit = document.getElementById("btnSwitchToEdit");
  const btnSubmitForm = document.getElementById("btnSubmitForm");
  const btnCancelForm = document.getElementById("btnCancelForm");
  if (btnSwitchToEdit) {
    btnSwitchToEdit.style.display = isDetailMode ? "inline-flex" : "none";
  }
  if (btnSubmitForm) {
    btnSubmitForm.style.display = isDetailMode ? "none" : "inline-block";
    btnSubmitForm.textContent = "保存";
    btnSubmitForm.style.padding = "";
    btnSubmitForm.style.fontSize = "";
  }
  if (btnCancelForm) {
    btnCancelForm.textContent = isDetailMode ? "閉じる" : "キャンセル";
  }
}

// メンバー詳細モーダルを開く
function openMemberDetailModal(sysId) {
  const rec = db.members.find(m => m.sysId === sysId);
  if (!rec) return;

  state.modal}