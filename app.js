// 教職の森 運営管理アプリ - フロントエンドロジック
// (AppSheet仕様 + Googleフォーム項目 + 調整さん風「月別・一括出欠登録・途中変更」機能搭載)

const STORAGE_KEY = "kyoshoku_no_mori_db_v4";
const GOOGLE_FORM_URL = "https://forms.gle/3qK6Dyzrwr1ZJYTh8";
const DEFAULT_SHEET_URL = "https://docs.google.com/spreadsheets/d/1CKIbToVcACvwItJYisJMtFfS7kYGg_1mH1-mbtqAXiY/edit?usp=sharing";

// ==========================================================
// Supabase 接続設定 & RBAC（ロールベースアクセス制御）定義
// ==========================================================
const SUPABASE_URL = window.SUPABASE_URL || "https://YOUR_PROJECT_ID.supabase.co";
const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "YOUR_SUPABASE_ANON_KEY";

const supabaseClient =
  window.supabase &&
  SUPABASE_URL.startsWith("http") &&
  !SUPABASE_URL.includes("YOUR_PROJECT_ID")
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

// 1. 役職（ロール）の内部定義値
const RBAC_ROLES = [
  "developer",      // 開発管理者
  "president",      // 代表
  "vice_president", // 副代表
  "manager",        // 運営メンバー
  "student",        // 在校生
  "alumni",         // OB・OG
  "guest"           // 未承認・デフォルト値
];

// 幹部・運営メンバー4役職の共通グループ
const ADMIN_ROLES = ["developer", "president", "vice_president", "manager"];

// 2. 役職ごとの権限マトリクス定義
const RBAC_PERMISSIONS = {
  // 【CSVダウンロード / DBプレビュー】
  csvDownload: ["developer", "president", "vice_president", "manager"],

  // 【メンバー管理】
  membersView: ["developer", "president", "vice_president", "manager"],
  membersEdit: ["developer", "president", "vice_president", "manager"],
  changeRoleToManager: ["developer", "president", "vice_president"],
  changeRoleToVicePresident: ["developer", "president", "vice_president"], // presidentにも付与
  changeRoleToPresident: ["developer", "president", "vice_president"],

  // 【タスク管理】
  tasksAll: ["developer", "president", "vice_president", "manager"],

  // 【イベント管理】
  eventsView: ["developer", "president", "vice_president", "manager", "student", "alumni"],
  eventsEdit: ["developer", "president", "vice_president", "manager"],

  // 【出欠調整】
  attendanceViewAndInput: ["developer", "president", "vice_president", "manager", "student"],
  attendanceManageDates: ["developer", "president", "vice_president", "manager"]
};

// 指定ロールが対象権限を持つか判定
function hasPermission(userRole, permissionKey) {
  const allowed = RBAC_PERMISSIONS[permissionKey] || [];
  return allowed.includes(userRole);
}

// メンバー編集画面で特定の「役職（日本語表示名）」への変更権限があるか判定
function canAssignMemberRole(userRole, targetRoleLabel) {
  if (targetRoleLabel === "代表") {
    return hasPermission(userRole, "changeRoleToPresident");
  }
  if (targetRoleLabel === "副代表") {
    return hasPermission(userRole, "changeRoleToVicePresident");
  }
  if (targetRoleLabel === "運営メンバー") {
    return hasPermission(userRole, "changeRoleToManager");
  }
  // 「在校生」「OB・OG」はメンバー編集権限を持つロール（developer, president, vice_president, manager）なら変更可
  return hasPermission(userRole, "membersEdit");
}

// Googleログイン実行（Supabase OAuth）
async function signInWithGoogle() {
  if (!supabaseClient) {
    alert(
      "Supabaseの接続URL（SUPABASE_URL / SUPABASE_ANON_KEY）が未設定です。\n画面上部の「🔐 現在のロール(RBAC)」プルダウンから各ロールの表示制御を直接テストできます。"
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

// 名簿データ（db.members）の役職表記を Supabase profiles.role の内部ロール値に変換するヘルパー関数
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
  // 名簿側に役職が設定されていればそれを使用し、未設定または該当なしの場合は「在校生（student）」とする
  return roleMap[normalized] || "student";
}

// アプリ起動時（またはログイン時）に profiles テーブルから自分の role を取得する
// 取得した自身のロールが guest だった場合、db.members のメールアドレスと照合して自動でロールを付与する
async function fetchCurrentUserRole() {
  if (!supabaseClient) {
    // Supabase未接続環境（ローカルプレビュー時）はプルダウン選択値または developer を使用
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

    const currentRole =
      !profErr && profile && RBAC_ROLES.includes(profile.role)
        ? profile.role
        : "guest";

    // 取得した自身のロールが guest だった場合、Googleフォーム（db.members）のメールアドレスと照合して自動昇格
    if (currentRole === "guest" && state.currentUser.email) {
      // スプレッドシート連携URLが設定されていれば、照合前に最新回答を db.members に同期しておく
      if (db.sheetSyncUrl) {
        try {
          const rows = await loadGoogleSheetViaJsonp(db.sheetSyncUrl);
          mergeMembersFromRows(rows);
        } catch (syncErr) {
          console.warn("自動ロール照合前のスプレッドシート同期をスキップしました:", syncErr);
        }
      }

      const loginEmail = state.currentUser.email.trim().toLowerCase();
      const matchedMember = db.members.find(
        m => m.email && String(m.email).trim().toLowerCase() === loginEmail
      );

      if (matchedMember) {
        // 名簿データ側に役職が設定されていればそれ（例: 運営メンバー -> manager）、なければ「在校生（student）」
        const assignedRole = mapMemberRoleToRbacRole(matchedMember.role);

        const { error: updateErr } = await supabaseClient
          .from("profiles")
          .update({ role: assignedRole })
          .eq("id", state.currentUser.id);

        if (!updateErr) {
          state.userRole = assignedRole;
          // UPDATE成功後、UIを再描画して自動的に管理者または一般メンバーの画面を表示させる
          applyRbacUi(assignedRole);
          renderFilters();
          renderView();
          return assignedRole;
        } else {
          console.error("Failed to auto-update user role in profiles:", updateErr);
        }
      }
    }

    return currentRole;
  } catch (e) {
    console.error("Failed to fetch user role from profiles:", e);
    return "guest";
  }
}

// 取得した role に基づき、タブやボタンの表示/非表示を一括制御する関数
function applyRbacUi(userRole = state.userRole) {
  const validRole = RBAC_ROLES.includes(userRole) ? userRole : "guest";
  state.userRole = validRole;

  // 上部ロール検証セレクターの表示同期
  const switcher = document.getElementById("rbacRoleSwitcher");
  if (switcher && switcher.value !== validRole) {
    switcher.value = validRole;
  }

  // 1. 各タブの閲覧権限判定
  const tabAccess = {
    members: hasPermission(validRole, "membersView"),
    tasks: hasPermission(validRole, "tasksAll"),
    events: hasPermission(validRole, "eventsView"),
    attendance: hasPermission(validRole, "attendanceViewAndInput")
  };

  // 下部ナビゲーションタブの表示/非表示とグリッド列数の自動調整
  let visibleTabCount = 0;
  document.querySelectorAll(".bottom-nav .nav-item").forEach(btn => {
    const viewName = btn.dataset.view;
    const allowed = Boolean(tabAccess[viewName]);
    btn.style.display = allowed ? "flex" : "none";
    if (allowed) visibleTabCount++;
  });

  const navInner = document.querySelector(".bottom-nav-inner");
  if (navInner) {
    navInner.style.gridTemplateColumns =
      visibleTabCount > 0 ? `repeat(${visibleTabCount}, 1fr)` : "1fr";
  }

  // 2. ヘッダーボタン（CSV/DBモーダル、Googleフォーム連携モーダル）の表示制御
  const btnOpenDbModal = document.getElementById("btnOpenDbModal");
  const btnDownloadCsv = document.getElementById("btnDownloadCsv");
  const btnOpenSyncModal = document.getElementById("btnOpenSyncModal");

  if (btnOpenDbModal) {
    btnOpenDbModal.style.display = hasPermission(validRole, "csvDownload") ? "inline-flex" : "none";
  }
  if (btnDownloadCsv) {
    btnDownloadCsv.style.display = hasPermission(validRole, "csvDownload") ? "inline-block" : "none";
  }
  if (btnOpenSyncModal) {
    btnOpenSyncModal.style.display = hasPermission(validRole, "membersEdit") ? "inline-flex" : "none";
  }

  // DBプレビューモーダル内のシート切替タブも権限に応じて制御
  document.querySelectorAll("#dbSheetTabs .view-toggle-btn").forEach(btn => {
    const s = btn.dataset.sheet;
    const allowed = Boolean(tabAccess[s]);
    btn.style.display = allowed ? "inline-block" : "none";
  });

  // 3. 現在開いているタブに対する閲覧権限がない場合、許可されている最初のタブへ自動遷移
  if (!tabAccess[state.currentView]) {
    const firstAllowedView = Object.keys(tabAccess).find(k => tabAccess[k]);
    if (firstAllowedView) {
      state.currentView = firstAllowedView;
      renderFilters();
      renderView();
      return;
    } else {
      // guest（未承認）など、閲覧可能なタブが1つもない場合
      const titleEl = document.getElementById("currentViewTitle");
      const countEl = document.getElementById("currentViewCount");
      const contentEl = document.getElementById("viewContent");
      const toolbar = document.querySelector(".toolbar-controls");
      const fab = document.getElementById("btnAddRecord");
      const btnClearTab = document.getElementById("btnClearCurrentTab");
      const eventsToggleWrap = document.getElementById("eventsViewToggleWrap");

      if (titleEl) titleEl.textContent = "アクセス権限の確認中";
      if (countEl) countEl.textContent = "guest（未承認）";
      if (toolbar) toolbar.style.display = "none";
      if (fab) fab.style.display = "none";
      if (btnClearTab) btnClearTab.style.display = "none";
      if (eventsToggleWrap) eventsToggleWrap.style.display = "none";
      if (contentEl) {
        contentEl.innerHTML = `
          <div class="empty-state">
            <h3 style="color: var(--text-main); margin-bottom: 8px;">🔒 アカウント承認待ち（guest）</h3>
            <p style="font-size: 0.88rem; line-height: 1.6;">
              現在あなたのロールは <strong>guest（未承認）</strong> に設定されています。<br />
              代表・副代表・運営メンバーまたは開発管理者によるロール承認が完了するまでお待ちください。
            </p>
          </div>
        `;
      }
      return;
    }
  }

  // 4. 表示中ビューに応じた追加ボタン（FAB）・一括削除ボタン・編集ボタン等の出し分け
  const fab = document.getElementById("btnAddRecord");
  const btnClearTab = document.getElementById("btnClearCurrentTab");

  if (state.currentView === "members") {
    const canEditMember = hasPermission(validRole, "membersEdit");
    if (fab) fab.style.display = canEditMember ? "flex" : "none";
    const btnDirectAdd = document.getElementById("btnDirectAddMember");
    if (btnDirectAdd) btnDirectAdd.style.display = canEditMember ? "inline-block" : "none";
  } else if (state.currentView === "tasks") {
    const canEditTask = hasPermission(validRole, "tasksAll");
    if (fab) fab.style.display = canEditTask ? "flex" : "none";
    if (btnClearTab) {
      btnClearTab.style.display = canEditTask && db.tasks.length > 0 ? "inline-block" : "none";
    }
  } else if (state.currentView === "events") {
    const canEditEvent = hasPermission(validRole, "eventsEdit");
    if (fab) fab.style.display = canEditEvent ? "flex" : "none";
    if (btnClearTab) {
      btnClearTab.style.display = canEditEvent && db.events.length > 0 ? "inline-block" : "none";
    }
  } else if (state.currentView === "attendance") {
    const canInputAttendance = hasPermission(validRole, "attendanceViewAndInput");
    const canManageDates = hasPermission(validRole, "attendanceManageDates");
    if (fab) fab.style.display = canInputAttendance ? "flex" : "none";
    if (btnClearTab) btnClearTab.style.display = canManageDates ? "inline-block" : "none";

    const btnAddMonthQuick = document.getElementById("btnAddMonthQuick");
    const btnManageDates = document.getElementById("btnManageDates");
    if (btnAddMonthQuick) btnAddMonthQuick.style.display = canManageDates ? "inline-block" : "none";
    if (btnManageDates) btnManageDates.style.display = canManageDates ? "inline-block" : "none";
  }

  // 5. 開いている詳細モーダル内の「✏️ 編集」「削除」ボタン制御
  const btnSwitchToEdit = document.getElementById("btnSwitchToEdit");
  const btnDeleteRecord = document.getElementById("btnDeleteRecord");
  if (state.modalMode === "memberDetail" && btnSwitchToEdit) {
    btnSwitchToEdit.style.display = hasPermission(validRole, "membersEdit") ? "inline-flex" : "none";
  } else if (state.modalMode === "eventDetail" && btnSwitchToEdit) {
    btnSwitchToEdit.style.display = hasPermission(validRole, "eventsEdit") ? "inline-flex" : "none";
  } else if (state.modalMode === "taskDetail") {
    const canEditTask = hasPermission(validRole, "tasksAll");
    if (btnSwitchToEdit) btnSwitchToEdit.style.display = canEditTask ? "inline-flex" : "none";
    if (btnDeleteRecord) btnDeleteRecord.style.display = canEditTask ? "inline-block" : "none";
  }
}

// 幹部管理用「役職」選択肢（要件定義書 3.1）
const ROLE_OPTIONS = ["代表", "副代表", "運営メンバー", "在校生", "OB・OG"];

// Googleフォーム「入学年度」選択肢（2023年度〜2030年度）
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

// Googleフォーム「希望教科」選択肢（複数選択可 / AppSheet: EnumList）
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

// 今日の日付（ローカルタイム YYYY-MM-DD）を取得
function getTodayIsoString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// イベントの開催日が今日より前（日付を超えた）なら自動で「終了」、それ以外は「開催」を返す（自動更新）
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

// 全イベントのステータスを現在日付に基づいて自動更新
function refreshAllEventStatuses(eventsList = []) {
  if (!Array.isArray(eventsList)) return;
  eventsList.forEach(ev => getAutoEventStatus(ev));
}

// AppSheetのUNIQUEID()相当（8文字16進数）
function generateUniqueId() {
  return Array.from({ length: 8 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

// AppSheetの自動採番式: "T" & RIGHT("0000" & (COUNT(タスク[システムID]) + 1), 4)
function generateSequentialId(prefix, count) {
  const numStr = "0000" + (count + 1);
  return prefix + numStr.slice(-4);
}

// 既存のイベント一覧から重複しない次のイベントID（E0001〜）を採番
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

// YYYY-MM-DD から "M/D (曜) 17:30〜" のような出欠表用ラベルを生成
function formatDateLabelFromIso(isoDate, timeSuffix = "17:30〜") {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate || "";
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];
  const w = dayNames[dt.getDay()];
  return timeSuffix ? `${m}/${d} (${w}) ${timeSuffix}` : `${m}/${d} (${w})`;
}

// YYYY-MM-DD を「○○○○年○○月○○日」（数字を少し大きく強調したHTML）にフォーマット
function formatEventDateHtml(isoDate) {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return `<span style="color: var(--text-muted); font-weight: 600;">開催日未定</span>`;
  }
  const [y, m, d] = isoDate.split("-");
  return `<span class="date-num">${escapeHtml(y)}</span><span class="date-unit">年</span><span class="date-num">${escapeHtml(m)}</span><span class="date-unit">月</span><span class="date-num">${escapeHtml(d)}</span><span class="date-unit">日</span>`;
}

// "11/4 (水) 16:30〜" などのラベルと対象月 "2026-11" から "2026-11-04" を推定
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
  lastSyncedAt: "2026/11/07 17:35:00",
  members: [
    {
      sysId: "m2301196",
      studentId: "2301196",
      name: "樋下田　大地",
      role: "在校生",
      admissionYear: "2023年度",
      discordName: "ひげた",
      subjects: ["高等学校 公民"]
    }
  ],
  tasks: [
    { sysId: "t101a2b3", taskId: "T0001", taskName: "春の教職ガイダンス スライド作成", status: "完了" },
    { sysId: "t202c3d4", taskId: "T0002", taskName: "模擬授業ワークショップ 教室予約", status: "進行中" },
    { sysId: "t303e5f6", taskId: "T0003", taskName: "新入生歓迎会 チラシ印刷・配布準備", status: "進行中" },
    { sysId: "t404a7b8", taskId: "T0004", taskName: "教員採用試験 対策勉強会アンケート集計", status: "未着手" },
    { sysId: "t505c9d0", taskId: "T0005", taskName: "OB・OG座談会 講師依頼メール送信", status: "保留" }
  ],
  events: [
    {
      sysId: "e100a0b1",
      eventId: "E0001",
      eventName: "定例ミーティング",
      eventDate: "2026-11-04"
    },
    {
      sysId: "e101f2a3",
      eventId: "E0002",
      eventName: "新入生向け 教職履修相談会",
      eventDate: "2026-11-11"
    },
    {
      sysId: "e202b4c5",
      eventId: "E0003",
      eventName: "第1回 模擬授業実践ワークショップ",
      eventDate: "2026-11-18"
    },
    {
      sysId: "e303d6e7",
      eventId: "E0004",
      eventName: "現役教員OB・OGを囲む座談会",
      eventDate: "2026-11-25"
    },
    {
      sysId: "e401c1d2",
      eventId: "E0005",
      eventName: "教採対策 勉強会①",
      eventDate: "2026-12-02"
    },
    {
      sysId: "e402c3d4",
      eventId: "E0006",
      eventName: "模擬授業 振り返り会",
      eventDate: "2026-12-09"
    },
    {
      sysId: "e403c5d6",
      eventId: "E0007",
      eventName: "年内最終 定例会・交流会",
      eventDate: "2026-12-16"
    }
  ],
  // 調整さん風「ひと月ごと」の出欠管理データ（イベントと双方向連携）
  monthlySchedules: {
    "2026-11": {
      monthKey: "2026-11",
      monthLabel: "2026年11月",
      dates: [
        { dateId: "d1104", isoDate: "2026-11-04", eventSysId: "e100a0b1", dateLabel: "11/4 (水) 17:30〜", title: "定例ミーティング" },
        { dateId: "d1111", isoDate: "2026-11-11", eventSysId: "e101f2a3", dateLabel: "11/11 (水) 17:30〜", title: "新入生向け 教職履修相談会" },
        { dateId: "d1118", isoDate: "2026-11-18", eventSysId: "e202b4c5", dateLabel: "11/18 (水) 17:30〜", title: "第1回 模擬授業実践ワークショップ" },
        { dateId: "d1125", isoDate: "2026-11-25", eventSysId: "e303d6e7", dateLabel: "11/25 (水) 17:30〜", title: "現役教員OB・OGを囲む座談会" }
      ],
      responses: {}
    },
    "2026-12": {
      monthKey: "2026-12",
      monthLabel: "2026年12月",
      dates: [
        { dateId: "d1202", isoDate: "2026-12-02", eventSysId: "e401c1d2", dateLabel: "12/2 (水) 17:30〜", title: "教採対策 勉強会①" },
        { dateId: "d1209", isoDate: "2026-12-09", eventSysId: "e402c3d4", dateLabel: "12/9 (水) 17:30〜", title: "模擬授業 振り返り会" },
        { dateId: "d1216", isoDate: "2026-12-16", eventSysId: "e403c5d6", dateLabel: "12/16 (水) 17:30〜", title: "年内最終 定例会・交流会" }
      ],
      responses: {}
    }
  }
};

let db = loadDb();
let state = {
  currentView: "members", // "members" | "tasks" | "events" | "attendance"
  eventsLayout: "list",   // "list" | "deck"（リストをデフォルト）
  selectedMonth: "2026-11",
  searchQuery: "",
  roleFilter: "ALL",
  yearFilter: "ALL",
  subjectFilter: "ALL",
  statusFilters: [...STATUS_OPTIONS], // 複数選択対応（初期状態は全ステータス選択）
  eventStatusFilters: [...EVENT_STATUS_OPTIONS], // イベントステータス複数選択フィルタ（「開催」「終了」）
  editingSysId: null,
  modalMode: "record", // "record" | "bulkAttendance" | "manageDates"
  activeDbSheet: "members",
  userRole: "developer", // RBACロール（developer | president | vice_president | manager | student | alumni | guest）
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
    if (!parsed.monthlySchedules) {
      parsed.monthlySchedules = structuredClone(DEFAULT_DB.monthlySchedules);
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
}

// ==========================================================
// 「イベント」と「出欠調整」の双方向連携ロジック
// ==========================================================

// 指定した月シートの日程を日付昇順でソート
function sortSheetDates(sheet) {
  if (!sheet || !Array.isArray(sheet.dates)) return;
  sheet.dates.sort((a, b) => {
    const isoA = a.isoDate || inferIsoDateFromLabel(sheet.monthKey, a.dateLabel);
    const isoB = b.isoDate || inferIsoDateFromLabel(sheet.monthKey, b.dateLabel);
    return isoA.localeCompare(isoB);
  });
}

// 「イベント」から「出欠調整」へ1件のイベントを同期（追加・更新・月移動・日付クリアに対応）
function syncEventToMonthlySchedule(ev, previousEventDate = null, targetDb = db) {
  if (!ev || !ev.sysId) return;

  // 以前の日付があり、日付がクリアされた・または別の月に変わった場合は旧月の日程から除去
  if (previousEventDate && previousEventDate !== ev.eventDate) {
    const oldYm = previousEventDate.slice(0, 7);
    const newYm = ev.eventDate ? ev.eventDate.slice(0, 7) : "";
    if (oldYm !== newYm && targetDb.monthlySchedules[oldYm]) {
      const oldSheet = targetDb.monthlySchedules[oldYm];
      oldSheet.dates = oldSheet.dates.filter(d => d.eventSysId !== ev.sysId);
    }
  }

  // 開催日が未設定になった場合は全月から紐づく日程を除去して終了
  if (!ev.eventDate || !/^\d{4}-\d{2}-\d{2}$/.test(ev.eventDate)) {
    removeEventFromMonthlySchedule(ev.sysId, targetDb);
    return;
  }

  const ym = ev.eventDate.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);

  // 該当月の出欠表がまだなければ自動作成
  if (!targetDb.monthlySchedules[ym]) {
    targetDb.monthlySchedules[ym] = {
      monthKey: ym,
      monthLabel: `${y}年${m}月`,
      dates: [],
      responses: {}
    };
  }

  const sheet = targetDb.monthlySchedules[ym];
  // 既にこのイベントに紐づいている日程、または同じ日付＆同タイトルの日程を探す
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
    if (oldIso !== ev.eventDate || !dateEntry.dateLabel) {
      dateEntry.dateLabel = formatDateLabelFromIso(ev.eventDate, "17:30〜");
    }
  } else {
    sheet.dates.push({
      dateId: "d_" + generateUniqueId(),
      isoDate: ev.eventDate,
      eventSysId: ev.sysId,
      dateLabel: formatDateLabelFromIso(ev.eventDate, "17:30〜"),
      title: ev.eventName
    });
  }

  sortSheetDates(sheet);
}

// イベント削除時に「出欠調整」の対応する候補日も削除
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

// 「出欠調整」で追加された候補日を「イベント」へ自動登録・紐づけ
function syncScheduleDateToEvents(ym, dateObj, targetDb = db) {
  if (!dateObj) return;
  if (!dateObj.isoDate) {
    dateObj.isoDate = inferIsoDateFromLabel(ym, dateObj.dateLabel);
  }
  if (!dateObj.dateLabel && dateObj.isoDate) {
    dateObj.dateLabel = formatDateLabelFromIso(dateObj.isoDate, "17:30〜");
  }

  // 既にイベントと紐づいている場合はイベント側の名前・日付を最新化
  if (dateObj.eventSysId) {
    const linked = targetDb.events.find(e => e.sysId === dateObj.eventSysId);
    if (linked) {
      linked.eventName = dateObj.title;
      if (dateObj.isoDate) linked.eventDate = dateObj.isoDate;
      return linked;
    }
  }

  // 同じ開催日＆イベント名の既存イベントがあればそれを紐づける
  const sameEvent = targetDb.events.find(
    e => e.eventDate === dateObj.isoDate && e.eventName === dateObj.title
  );
  if (sameEvent) {
    dateObj.eventSysId = sameEvent.sysId;
    return sameEvent;
  }

  // 新規イベントとして db.events に追加
  const newEv = {
    sysId: "e_" + generateUniqueId(),
    eventId: generateNextEventId(targetDb.events),
    eventName: dateObj.title || "サークル活動",
    eventDate: dateObj.isoDate || ""
  };
  getAutoEventStatus(newEv);
  targetDb.events.push(newEv);
  dateObj.eventSysId = newEv.sysId;
  return newEv;
}

// 対象月全体の「出欠調整」と「イベント」を双方向同期（月追加時などに呼び出し）
function syncMonthScheduleAndEvents(ym, targetDb = db) {
  const sheet = targetDb.monthlySchedules[ym];
  if (!sheet) return;

  // 1. その月のシートにある候補日をすべて db.events に同期
  sheet.dates.forEach(d => {
    syncScheduleDateToEvents(ym, d, targetDb);
  });

  // 2. すでに db.events に登録されている同月のイベントがあればシートにも反映
  targetDb.events.forEach(ev => {
    if (ev.eventDate && ev.eventDate.startsWith(ym + "-")) {
      syncEventToMonthlySchedule(ev, null, targetDb);
    }
  });

  sortSheetDates(sheet);
}

// 起動時に既存の「イベント」と「出欠調整」を突合・双方向同期
function reconcileEventsAndSchedules(targetDb = db) {
  if (!targetDb) return;
  if (!Array.isArray(targetDb.events)) targetDb.events = [];
  if (!targetDb.monthlySchedules) targetDb.monthlySchedules = {};

  // まず各月シートの候補日に isoDate を補完し、同日のイベントまたは新規イベントと紐づけ
  Object.keys(targetDb.monthlySchedules).forEach(ym => {
    const sheet = targetDb.monthlySchedules[ym];
    if (!sheet || !Array.isArray(sheet.dates)) return;
    sheet.dates.forEach(d => {
      if (!d.isoDate) {
        d.isoDate = inferIsoDateFromLabel(ym, d.dateLabel);
      }
      if (!d.eventSysId) {
        // 同じ日付のイベントで、まだ他の日程から参照されていないものがあればリンク
        const candidateEv = targetDb.events.find(
          e =>
            e.eventDate === d.isoDate &&
            !sheet.dates.some(other => other !== d && other.eventSysId === e.sysId)
        );
        if (candidateEv) {
          d.eventSysId = candidateEv.sysId;
          d.title = candidateEv.eventName;
        } else {
          syncScheduleDateToEvents(ym, d, targetDb);
        }
      }
    });
  });

  // 次に開催日を持つすべてのイベントを出欠調整シートへ反映し、ステータスも自動更新
  targetDb.events.forEach(ev => {
    getAutoEventStatus(ev);
    if (ev.eventDate) {
      syncEventToMonthlySchedule(ev, null, targetDb);
    }
  });
}

// ==========================================================
// Googleフォーム（回答先スプレッドシート / CSV）連携ロジック
// ==========================================================

// スプレッドシートの共有URLや公開URLからCSV取得用URLへ自動変換
function buildCsvExportUrl(rawUrl) {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return "";

  // すでに output=csv または format=csv または tqx=out:csv が含まれている場合
  if (trimmed.includes("output=csv") || trimmed.includes("format=csv") || trimmed.includes("tqx=out:csv")) {
    return trimmed;
  }

  // 「ウェブに公開」の /pubhtml URL の場合
  if (trimmed.includes("/spreadsheets/d/e/") && trimmed.includes("/pub")) {
    return trimmed.replace(/\/pubhtml.*$/, "/pub?output=csv").replace(/\/pub(\?.*)?$/, "/pub?output=csv");
  }

  // 通常のGoogleスプレッドシートURL: https://docs.google.com/spreadsheets/d/{ID}/edit#gid={GID}
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match) {
    const sheetId = match[1];
    const gidMatch = trimmed.match(/[#&?]gid=([0-9]+)/);
    const gidParam = gidMatch ? `&gid=${gidMatch[1]}` : "";
    return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv${gidParam}`;
  }

  return trimmed;
}

// RFC4180準拠CSVパーサー（Googleフォームの「希望教科」などカンマを含む引用符付きセルに完全対応）
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

// 2次元配列（1行目＝ヘッダー、2行目以降＝データ）からメンバーを取り込み・マージする共通関数
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
    // ヘッダー行がデータ行に混入している場合はスキップ
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

    // 既存メンバーを学籍番号・メールアドレス・氏名で検索し、役職を維持したまま上書きマージ
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

// CSVテキスト（Googleフォーム回答シート）からメンバーを取り込み・マージする
function mergeMembersFromCsvText(csvText) {
  const rows = parseCsvText(csvText);
  return mergeMembersFromRows(rows);
}

// ローカルファイル（file://）からでもCORSエラー（Failed to fetch）にならずに
// Googleスプレッドシートのデータを取得できるJSONPローダー
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

      // colsに「学籍番号」「名前」「メール」が入っている場合はcolsをヘッダー行として採用
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

// バッジ用ヘルパー
function getRoleBadgeClass(role) {
  switch (role) {
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
  } else {
    container.innerHTML = "";
  }
}

// レコード単体削除ヘルパー（メンバー削除時は月別出欠データからも回答を削除、イベント削除時は出欠調整の候補日も削除）
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

  // ナビゲーションのアクティブ状態更新
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.view === state.currentView);
  });

  if (state.currentView === "members") {
    titleEl.textContent = "メンバー";
    fabLabel.textContent = "メンバー追加（Googleフォーム ↗）";
    eventsToggleWrap.style.display = "none";
    if (btnClearTab) {
      btnClearTab.style.display = "none";
    }

    // システムIDは検索対象外（SHOW? = false）
    const filtered = db.members.filter(m => {
      const subjectsArr = Array.isArray(m.subjects) ? m.subjects : [];
      const matchSearch =
        !q ||
        (m.studentId || "").toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
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
          <strong>🔗 Googleフォーム連携:</strong>
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
    if (btnClearTab) {
      btnClearTab.textContent = "🗑️ タスクを全件削除";
      btnClearTab.style.display = db.tasks.length > 0 ? "inline-block" : "none";
    }

    // システムIDは検索対象外、進捗フィルタは複数選択対応
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
      contentEl.innerHTML = `<div class="empty-state">該当するタスクがありません（進捗フィルターのチェック状態または検索ワードをご確認ください）。</div>`;
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
          return `
            <article class="list-row item-card-clickable" data-task-row="${escapeHtml(t.sysId)}">
              <div class="item-main" style="flex-direction: column; align-items: flex-start; gap: 4px;">
                <div class="task-parallel-row">
                  <span class="task-id-large">${escapeHtml(t.taskId)}</span>
                  <span class="badge task-status-large ${getStatusBadgeClass(t.status)}">${escapeHtml(t.status)}</span>
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
    if (btnClearTab) {
      btnClearTab.textContent = "🗑️ イベントを全件削除";
      btnClearTab.style.display = db.events.length > 0 ? "inline-block" : "none";
    }

    // 描画前に全イベントのステータスを現在日付に基づき自動判定（開催日を超えたら自動で「終了」）
    refreshAllEventStatuses(db.events);

    // システムIDは検索対象外、ステータスフィルタにも対応
    const filtered = db.events.filter(ev => {
      const evStatus = getAutoEventStatus(ev);
      const jpDate =
        ev.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(ev.eventDate)
          ? ev.eventDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$1年$2月$3日")
          : "";
      const matchSearch =
        !q ||
        ev.eventId.toLowerCase().includes(q) ||
        ev.eventName.toLowerCase().includes(q) ||
        (ev.eventDate || "").toLowerCase().includes(q) ||
        jpDate.toLowerCase().includes(q) ||
        evStatus.toLowerCase().includes(q);
      const matchStatus = state.eventStatusFilters.includes(evStatus);
      return matchSearch && matchStatus;
    });

    countEl.textContent = `${filtered.length}件`;

    if (filtered.length === 0) {
      contentEl.innerHTML = `<div class="empty-state">該当するイベント企画がありません（ステータスフィルターのチェック状態または検索ワードをご確認ください）。</div>`;
      return;
    }

    if (state.eventsLayout === "deck") {
      contentEl.innerHTML = `
        <div class="card-grid">
          ${filtered.map(ev => {
            const evStatus = getAutoEventStatus(ev);
            return `
              <article class="item-card item-card-clickable" data-event-detail="${escapeHtml(ev.sysId)}" role="button" tabindex="0" aria-label="${escapeHtml(ev.eventName)}の詳細を表示">
                <div class="item-main" style="flex-direction: column; align-items: flex-start; gap: 8px; width: 100%;">
                  <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span class="badge badge-id">${escapeHtml(ev.eventId)}</span>
                      <span class="badge ${getEventStatusBadgeClass(evStatus)}">${escapeHtml(evStatus)}</span>
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
              <article class="list-row item-card-clickable" data-event-detail="${escapeHtml(ev.sysId)}" role="button" tabindex="0" aria-label="${escapeHtml(ev.eventName)}の詳細を表示">
                <div class="item-main" style="flex-direction: column; align-items: flex-start; gap: 8px; width: 100%;">
                  <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                      <span class="badge badge-id">${escapeHtml(ev.eventId)}</span>
                      <span class="badge ${getEventStatusBadgeClass(evStatus)}">${escapeHtml(evStatus)}</span>
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
    if (btnClearTab) {
      btnClearTab.textContent = "🗑️ この月の出欠回答をリセット";
      btnClearTab.style.display = "inline-block";
    }
    renderAttendanceView();
    return;
  }

  // イベントバインド（詳細ボタン、編集ボタン、直接削除ボタン、クイック進捗変更、出欠タブ遷移）
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

  // 描画後にRBAC表示制御を適用
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
  fabLabel.textContent = "出欠を一括入力・変更";
  eventsToggleWrap.style.display = "none";

  const monthKeys = Object.keys(db.monthlySchedules).sort();
  if (!db.monthlySchedules[state.selectedMonth] && monthKeys.length > 0) {
    state.selectedMonth = monthKeys[0];
  }
  const sheet = db.monthlySchedules[state.selectedMonth];
  const dates = sheet ? sheet.dates : [];
  const responses = sheet ? sheet.responses : {};

  // 回答済みメンバー数カウント
  const answeredCount = db.members.filter(m => responses[m.sysId]).length;
  countEl.textContent = `回答 ${answeredCount}/${db.members.length}名`;

  // 各日程の◯カウントの最大値を計算（最多参加可能日をハイライトするため）
  let maxOkCount = 0;
  const dateStats = dates.map(d => {
    let ok = 0, maybe = 0, ng = 0;
    db.members.forEach(m => {
      const mark = responses[m.sysId]?.marks?.[d.dateId];
      if (mark === "◯") ok++;
      else if (mark === "△") maybe++;
      else if (mark === "✕") ng++;
    });
    if (ok > maxOkCount) maxOkCount = ok;
    return { ...d, ok, maybe, ng };
  });

  contentEl.innerHTML = `
    <div class="attendance-top-bar">
      <div class="month-selector-group">
        <label for="monthSelect" style="font-weight: 700; font-size: 0.9rem;">📅 対象月:</label>
        <select id="monthSelect" class="month-select">
          ${monthKeys.map(k => {
            const mSheet = db.monthlySchedules[k];
            return `<option value="${escapeHtml(k)}" ${k === state.selectedMonth ? "selected" : ""}>${escapeHtml(mSheet.monthLabel)}（${mSheet.dates.length}日程）</option>`;
          }).join("")}
        </select>
        <button type="button" class="btn-icon" id="btnAddMonthQuick" style="font-weight: 700; color: var(--primary-dark); border-color: var(--primary);">
          ＋ 対象月を追加
        </button>
        <button type="button" class="btn-icon" id="btnManageDates">⚙️ 候補日の追加・削除</button>
      </div>
    </div>

    <div style="margin-bottom: 10px; font-size: 0.82rem; color: var(--text-muted); display: flex; flex-wrap: wrap; gap: 12px; align-items: center;">
      <span>💡 <strong>使い方:</strong> メンバー名をクリックすると一括変更画面が開きます。表の「◯ / △ / ✕」マスを直接タップして1日ずつ切り替えることも可能です。</span>
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
              ${db.members.map(m => `
                <th>
                  <button type="button" class="member-col-btn" data-bulk-member="${escapeHtml(m.sysId)}" title="クリックして${escapeHtml(m.name)}さんの出欠を一括変更">
                    ${escapeHtml(m.name)}
                  </button>
                  <div style="font-size: 0.68rem; color: var(--text-muted); font-weight: 500;">${escapeHtml(m.role)}</div>
                </th>
              `).join("")}
            </tr>
          </thead>
          <tbody>
            ${dateStats.map(d => {
              const isBest = maxOkCount > 0 && d.ok === maxOkCount;
              return `
                <tr class="${isBest ? "best-date-row" : ""}">
                  <td class="col-date-label">
                    <div>${isBest ? "★ " : ""}${escapeHtml(d.dateLabel)}</div>
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 400;">${escapeHtml(d.title)}</div>
                  </td>
                  <td><span class="count-pill count-ok">${d.ok}</span></td>
                  <td><span class="count-pill count-maybe">${d.maybe}</span></td>
                  <td><span class="count-pill count-ng">${d.ng}</span></td>
                  ${db.members.map(m => {
                    const mark = responses[m.sysId]?.marks?.[d.dateId] || "-";
                    return `
                      <td
                        class="mark-cell ${getMarkClass(mark)}"
                        data-cell-member="${escapeHtml(m.sysId)}"
                        data-cell-date="${escapeHtml(d.dateId)}"
                        title="タップして ${escapeHtml(m.name)} さんの ${escapeHtml(d.dateLabel)} の出欠を切替"
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

  // 月の切り替え
  document.getElementById("monthSelect").addEventListener("change", e => {
    state.selectedMonth = e.target.value;
    renderAttendanceView();
  });

  // メンバー名クリックでその人の一括変更モーダルを開く
  contentEl.querySelectorAll("[data-bulk-member]").forEach(btn => {
    btn.addEventListener("click", () => {
      openBulkAttendanceModal(btn.dataset.bulkMember);
    });
  });

  // セル直接タップで「◯ → △ → ✕ → ◯」と即座に切り替え（途中変更のワンタップ操作）
  contentEl.querySelectorAll("[data-cell-member]").forEach(cell => {
    cell.addEventListener("click", () => {
      const mId = cell.dataset.cellMember;
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

  // 対象月の追加モーダル
  document.getElementById("btnAddMonthQuick").addEventListener("click", () => {
    openAddMonthModal();
  });

  // 日程・月の管理モーダル
  document.getElementById("btnManageDates").addEventListener("click", () => {
    openManageDatesModal();
  });

  // 出欠調整画面の描画後にRBAC表示制御を適用
  applyRbacUi(state.userRole);
}

// 指定した年・月の特定曜日（複数選択可、例: [1, 3] = 月・水）の日付リストを自動生成するヘルパー
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
        title: defaultTitle
      });
    }
    date.setDate(date.getDate() + 1);
  }
  return result;
}

// モーダル内のヘッダー編集ボタン・フッター保存ボタンの表示状態をリセット
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

// メンバー詳細モーダルを開く（右上「✏️ 編集」ボタンから編集画面へ遷移）
function openMemberDetailModal(sysId) {
  const rec = db.members.find(m => m.sysId === sysId);
  if (!rec) return;

  state.modalMode = "memberDetail";
  state.editingSysId = sysId;

  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");

  resetFormModalButtons(true);
  btnDelete.style.display = "none";
  titleEl.textContent = "メンバー詳細";

  const subjectsArr = Array.isArray(rec.subjects) ? rec.subjects : [];

  bodyEl.innerHTML = `
    <div class="detail-hero">
      <div class="detail-avatar">${escapeHtml(rec.name.slice(0, 1))}</div>
      <div>
        <div style="font-size: 1.15rem; font-weight: 700; color: var(--text-main);">
          ${escapeHtml(rec.name)}
        </div>
        <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px;">
          <span class="badge ${getRoleBadgeClass(rec.role)}">${escapeHtml(rec.role)}</span>
          ${rec.discordName ? `<span class="badge badge-discord">💬 ${escapeHtml(rec.discordName)}</span>` : ""}
        </div>
      </div>
    </div>

    <div class="detail-list">
      <div class="detail-item">
        <div class="detail-label">🪪 学籍番号</div>
        <div class="detail-value" style="font-family: ui-monospace, SFMono-Regular, Consolas, monospace;">
          ${escapeHtml(rec.studentId || "未設定")}
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">🎓 入学年度</div>
        <div class="detail-value">
          ${escapeHtml(rec.admissionYear || "未設定")}
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">📘 希望教科</div>
        <div class="detail-value">
          ${subjectsArr.length > 0
            ? `<div class="subject-list" style="margin-top: 2px;">
                ${subjectsArr.map(sub => `<span class="badge badge-subject">📘 ${escapeHtml(sub)}</span>`).join("")}
               </div>`
            : `<span style="color: var(--text-muted); font-weight: 400;">未設定</span>`
          }
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">💬 Discordユーザー名</div>
        <div class="detail-value">
          ${escapeHtml(rec.discordName || "未設定")}
        </div>
      </div>
    </div>
  `;

  applyRbacUi(state.userRole);
  modal.classList.add("open");
}

// タスク詳細モーダルを開く（右上「✏️ 編集」ボタンとフッター「削除」ボタンを統合）
function openTaskDetailModal(sysId) {
  const rec = db.tasks.find(t => t.sysId === sysId);
  if (!rec) return;

  state.modalMode = "taskDetail";
  state.editingSysId = sysId;

  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");

  resetFormModalButtons(true);
  btnDelete.style.display = "inline-block";
  titleEl.textContent = "タスク詳細";

  const formattedDue =
    rec.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(rec.dueDate)
      ? formatEventDateHtml(rec.dueDate)
      : rec.dueDate
      ? escapeHtml(rec.dueDate)
      : `<span style="color: var(--text-muted); font-weight: 400;">未設定（期限なし）</span>`;

  bodyEl.innerHTML = `
    <div class="detail-hero">
      <div class="detail-avatar" style="border-radius: 12px;">✅</div>
      <div>
        <div style="margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <span class="badge badge-id">${escapeHtml(rec.taskId)}</span>
          <span class="badge ${getStatusBadgeClass(rec.status)}">${escapeHtml(rec.status)}</span>
        </div>
        <div style="font-size: 1.2rem; font-weight: 800; color: var(--text-main);">
          ${escapeHtml(rec.taskName)}
        </div>
      </div>
    </div>

    <div class="detail-list">
      <div class="detail-item">
        <div class="detail-label">🆔 タスクID</div>
        <div class="detail-value" style="font-family: ui-monospace, SFMono-Regular, Consolas, monospace;">
          ${escapeHtml(rec.taskId)}
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">📊 進捗</div>
        <div class="detail-value">
          <span class="badge ${getStatusBadgeClass(rec.status)}" style="font-size: 0.88rem; padding: 4px 12px;">${escapeHtml(rec.status)}</span>
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">👤 担当者（任意）</div>
        <div class="detail-value">
          ${rec.assignee
            ? `<span>👤 ${escapeHtml(rec.assignee)}</span>`
            : `<span style="color: var(--text-muted); font-weight: 400;">未設定</span>`
          }
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">⏰ 期限（任意）</div>
        <div class="detail-value" style="font-size: 1.02rem;">
          ${formattedDue}
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">📝 メモ（任意）</div>
        <div class="detail-value" style="white-space: pre-wrap; font-weight: 500; line-height: 1.55;">
          ${rec.memo
            ? escapeHtml(rec.memo)
            : `<span style="color: var(--text-muted); font-weight: 400;">メモなし</span>`
          }
        </div>
      </div>
    </div>
  `;

  applyRbacUi(state.userRole);
  modal.classList.add("open");
}

// イベント詳細モーダルを開く（右上「✏️ 編集」ボタンから編集・削除画面へ遷移）
function openEventDetailModal(sysId) {
  const rec = db.events.find(ev => ev.sysId === sysId);
  if (!rec) return;

  state.modalMode = "eventDetail";
  state.editingSysId = sysId;

  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");

  resetFormModalButtons(true);
  btnDelete.style.display = "none";
  titleEl.textContent = "イベント詳細";

  // 出欠調整タブで紐づいている日程・参加予定メンバーの内訳を取得
  let attendanceSummaryHtml = `<span style="color: var(--text-muted); font-weight: 400;">開催日未設定のため出欠表未連携</span>`;
  if (rec.eventDate && /^\d{4}-\d{2}-\d{2}$/.test(rec.eventDate)) {
    const ym = rec.eventDate.slice(0, 7);
    const sheet = db.monthlySchedules[ym];
    const dateEntry = sheet?.dates?.find(d => d.eventSysId === rec.sysId || d.isoDate === rec.eventDate);
    if (sheet && dateEntry) {
      const okMembers = [];
      const maybeMembers = [];
      const ngMembers = [];
      const unansweredMembers = [];

      db.members.forEach(m => {
        const resp = sheet.responses?.[m.sysId];
        const mark = resp?.marks?.[dateEntry.dateId];
        const comment = resp?.comment ? `（💬 ${resp.comment}）` : "";
        const item = { name: m.name, role: m.role, comment };
        if (mark === "◯") okMembers.push(item);
        else if (mark === "△") maybeMembers.push(item);
        else if (mark === "✕") ngMembers.push(item);
        else unansweredMembers.push(item);
      });

      const renderMemberTags = (list, bgStyle) =>
        list.length > 0
          ? `<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px;">
              ${list
                .map(
                  m => `
                    <span class="badge" style="${bgStyle}; font-size: 0.82rem; padding: 4px 10px;">
                      ${escapeHtml(m.name)}${m.comment ? `<span style="font-weight: 400; font-size: 0.74rem; margin-left: 4px;">${escapeHtml(m.comment)}</span>` : ""}
                    </span>
                  `
                )
                .join("")}
            </div>`
          : `<div style="font-size: 0.8rem; color: var(--text-muted); font-weight: 400; margin-top: 4px;">該当者なし</div>`;

      attendanceSummaryHtml = `
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <div style="font-size: 0.85rem; color: var(--text-muted); font-weight: 600;">
            対象日程: ${escapeHtml(sheet.monthLabel)} ${escapeHtml(dateEntry.dateLabel)}
          </div>

          <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 12px;">
            <div style="display: flex; align-items: center; gap: 6px; font-size: 0.88rem; font-weight: 700; color: #065f46;">
              <span class="count-pill count-ok">◯ 出席</span>
              <span>${okMembers.length}名</span>
            </div>
            ${renderMemberTags(okMembers, "background: #ffffff; color: #065f46; border: 1px solid #86efac;")}
          </div>

          <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 10px 12px;">
            <div style="display: flex; align-items: center; gap: 6px; font-size: 0.88rem; font-weight: 700; color: #92400e;">
              <span class="count-pill count-maybe">△ 微妙・調整中</span>
              <span>${maybeMembers.length}名</span>
            </div>
            ${renderMemberTags(maybeMembers, "background: #ffffff; color: #92400e; border: 1px solid #fcd34d;")}
          </div>

          <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 10px 12px;">
            <div style="display: flex; align-items: center; gap: 6px; font-size: 0.88rem; font-weight: 700; color: #991b1b;">
              <span class="count-pill count-ng">✕ 欠席</span>
              <span>${ngMembers.length}名</span>
            </div>
            ${renderMemberTags(ngMembers, "background: #ffffff; color: #991b1b; border: 1px solid #fca5a5;")}
          </div>

          ${unansweredMembers.length > 0 ? `
            <div style="background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px;">
              <div style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted);">
                未回答（${unansweredMembers.length}名）
              </div>
              ${renderMemberTags(unansweredMembers, "background: #ffffff; color: #64748b; border: 1px solid #cbd5e1;")}
            </div>
          ` : ""}
        </div>
      `;
    }
  }

  const evStatus = getAutoEventStatus(rec);

  bodyEl.innerHTML = `
    <div class="detail-hero">
      <div class="detail-avatar" style="border-radius: 12px;">📅</div>
      <div>
        <div style="margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
          <span class="badge badge-id">${escapeHtml(rec.eventId)}</span>
          <span class="badge ${getEventStatusBadgeClass(evStatus)}">${escapeHtml(evStatus)}</span>
        </div>
        <div style="font-size: 1.2rem; font-weight: 800; color: var(--text-main);">
          ${escapeHtml(rec.eventName)}
        </div>
      </div>
    </div>

    <div class="detail-list">
      <div class="detail-item">
        <div class="detail-label">🆔 イベントID</div>
        <div class="detail-value" style="font-family: ui-monospace, SFMono-Regular, Consolas, monospace;">
          ${escapeHtml(rec.eventId)}
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">📌 ステータス</div>
        <div class="detail-value">
          <span class="badge ${getEventStatusBadgeClass(evStatus)}" style="font-size: 0.85rem;">${escapeHtml(evStatus)}</span>
          <span style="font-size: 0.78rem; color: var(--text-muted); font-weight: 400; margin-left: 6px;">※開催日を過ぎると自動で「終了」に切り替わります</span>
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">🗓️ 開催日</div>
        <div class="detail-value" style="font-size: 1.05rem;">
          ${formatEventDateHtml(rec.eventDate)}
        </div>
      </div>

      <div class="detail-item">
        <div class="detail-label">📊 出欠調整の状況</div>
        <div class="detail-value">
          ${attendanceSummaryHtml}
        </div>
      </div>
    </div>
  `;

  applyRbacUi(state.userRole);
  modal.classList.add("open");
}

// 「＋ 対象月を追加」専用モーダル（ステップ1: 年月・曜日の選択 → ステップ2: 追加する日程をリストでチェック選択）
function openAddMonthModal() {
  state.modalMode = "addMonth";
  state.pendingAddMonthData = null;
  resetFormModalButtons(false);
  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");
  const btnSubmitForm = document.getElementById("btnSubmitForm");

  btnDelete.style.display = "none";
  if (btnSubmitForm) {
    btnSubmitForm.textContent = "出欠表を作成する";
    btnSubmitForm.style.padding = "12px 24px";
    btnSubmitForm.style.fontSize = "1rem";
  }
  titleEl.textContent = "📅 新しい対象月（出欠表）の追加";

  const years = [2026, 2027, 2028, 2029, 2030];
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const weekdayOptions = [
    { val: 1, label: "毎週月曜日（17:30〜）", defaultChecked: true },
    { val: 2, label: "毎週火曜日（17:30〜）", defaultChecked: false },
    { val: 3, label: "毎週水曜日（17:30〜）", defaultChecked: true },
    { val: 4, label: "毎週木曜日（17:30〜）", defaultChecked: false },
    { val: 5, label: "毎週金曜日（17:30〜）", defaultChecked: false },
    { val: 6, label: "毎週土曜日（17:30〜）", defaultChecked: false },
    { val: 0, label: "毎週日曜日（17:30〜）", defaultChecked: false }
  ];

  bodyEl.innerHTML = `
    <div class="form-group">
      <label class="form-label">1. 追加する「年・月」を選択</label>
      <div style="display: flex; gap: 8px; align-items: center;">
        <select id="addMonthYear" class="form-control" style="font-weight: 700;">
          ${years.map(y => `<option value="${y}" ${y === 2027 ? "selected" : ""}>${y}年</option>`).join("")}
        </select>
        <select id="addMonthNum" class="form-control" style="font-weight: 700;">
          ${months.map(m => `<option value="${m}" ${m === 1 ? "selected" : ""}>${m}月</option>`).join("")}
        </select>
      </div>
    </div>

    <div class="form-group">
      <label class="form-label">2. 初期候補日の自動作成オプション（複数選択可・17:30〜）</label>
      <div class="checkbox-grid" id="addMonthWeekdaysGroup">
        ${weekdayOptions.map(w => `
          <label class="checkbox-item">
            <input type="checkbox" name="addMonthWeekdays" value="${w.val}" ${w.defaultChecked ? "checked" : ""} />
            <span>${w.label}</span>
          </label>
        `).join("")}
      </div>
      <span class="form-hint">※「出欠表を作成する」を押すと、次の画面で自動生成された日程がリスト表示され、チェックボックスで実際に追加する日程を取捨選択できます。</span>
    </div>
  `;

  modal.classList.add("open");
}

// ステップ2: 生成された候補日リストから実際に追加する日程をチェックボックスで選択する画面
function openConfirmMonthDatesModal(y, m, ym, candidateDates) {
  state.modalMode = "confirmMonthDates";
  state.pendingAddMonthData = { y, m, ym, candidateDates };
  resetFormModalButtons(false);

  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");
  const btnSubmitForm = document.getElementById("btnSubmitForm");

  btnDelete.style.display = "none";
  if (btnSubmitForm) {
    btnSubmitForm.textContent = "選択した日程で追加する";
    btnSubmitForm.style.padding = "12px 24px";
    btnSubmitForm.style.fontSize = "1rem";
  }
  titleEl.textContent = `📅 ${y}年${m}月 追加する日程の選択`;

  bodyEl.innerHTML = `
    <div class="form-group">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
        <label class="form-label">実際に追加する日程にチェックを入れてください（${candidateDates.length}件）</label>
        <div style="display: flex; gap: 6px;">
          <button type="button" class="btn-icon" id="btnSelectAllCandidateDates" style="font-size: 0.75rem; padding: 4px 8px;">すべて選択</button>
          <button type="button" class="btn-icon" id="btnDeselectAllCandidateDates" style="font-size: 0.75rem; padding: 4px 8px;">全解除</button>
        </div>
      </div>

      <div class="list-stack" style="margin-top: 6px; gap: 8px;" id="confirmDatesList">
        ${candidateDates.map((d, idx) => `
          <label class="list-row" style="cursor: pointer; padding: 10px 14px; flex-direction: row; align-items: center; justify-content: flex-start; gap: 12px;">
            <input
              type="checkbox"
              name="confirmMonthDateItem"
              value="${idx}"
              checked
              style="width: 18px; height: 18px; accent-color: var(--primary); cursor: pointer; flex-shrink: 0;"
            />
            <div style="display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0;">
              <div style="font-weight: 800; font-size: 0.98rem; color: var(--primary-dark);">
                ${escapeHtml(d.dateLabel)}
              </div>
              <input
                type="text"
                class="form-control"
                data-candidate-title="${idx}"
                value="${escapeHtml(d.title)}"
                placeholder="活動内容・イベント名"
                style="padding: 6px 10px; font-size: 0.85rem;"
              />
            </div>
          </label>
        `).join("")}
      </div>
      <span class="form-hint" id="confirmDateErrorHint" style="color: var(--danger); display: none; font-weight: 700;">※追加する日程を1つ以上選択してください。</span>
      <span class="form-hint">※祝日や休講日などのチェックを外すことで除外でき、各日程の活動名もその場で編集できます。</span>
    </div>

    <div>
      <button type="button" class="btn btn-secondary" id="btnBackToAddMonthStep1" style="font-size: 0.82rem; padding: 6px 12px;">
        ← 年月・曜日の選択に戻る
      </button>
    </div>
  `;

  // タイトル入力欄をクリックした時にチェックボックスが反転しないようにする
  bodyEl.querySelectorAll("[data-candidate-title]").forEach(input => {
    input.addEventListener("click", e => e.stopPropagation());
  });

  document.getElementById("btnSelectAllCandidateDates")?.addEventListener("click", () => {
    bodyEl.querySelectorAll('input[name="confirmMonthDateItem"]').forEach(cb => {
      cb.checked = true;
    });
  });

  document.getElementById("btnDeselectAllCandidateDates")?.addEventListener("click", () => {
    bodyEl.querySelectorAll('input[name="confirmMonthDateItem"]').forEach(cb => {
      cb.checked = false;
    });
  });

  document.getElementById("btnBackToAddMonthStep1")?.addEventListener("click", () => {
    openAddMonthModal();
  });

  modal.classList.add("open");
}

// 調整さん風「ひと月分の一括出欠登録・途中変更」モーダル
function openBulkAttendanceModal(defaultMemberSysId = null) {
  state.modalMode = "bulkAttendance";
  resetFormModalButtons(false);
  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");

  const sheet = db.monthlySchedules[state.selectedMonth];
  if (!sheet) return;

  const selectedSysId = defaultMemberSysId || db.members[0]?.sysId;
  btnDelete.style.display = "none";
  titleEl.textContent = `🗓️ ${sheet.monthLabel} 出欠の一括登録・変更`;

  function renderBulkFormForMember(memberSysId) {
    const existing = sheet.responses[memberSysId] || { marks: {}, comment: "" };
    const isAlreadyAnswered = Boolean(sheet.responses[memberSysId]);

    bodyEl.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="bulkMemberSelect">
          1. あなたの名前を選択 <span class="ro-tag">名簿連動・表記ゆれ防止</span>
        </label>
        <select id="bulkMemberSelect" class="form-control" style="font-weight: 700;">
          ${db.members.map(m => `
            <option value="${escapeHtml(m.sysId)}" ${m.sysId === memberSysId ? "selected" : ""}>
              ${escapeHtml(m.name)}（${escapeHtml(m.studentId || "")} / ${escapeHtml(m.role)}）
              ${sheet.responses[m.sysId] ? "✓回答済・変更可" : "未回答"}
            </option>
          `).join("")}
        </select>
        <span class="form-hint" style="color: ${isAlreadyAnswered ? "var(--primary)" : "var(--text-muted)"}; font-weight: 600;">
          ${isAlreadyAnswered
            ? "🔄 登録済みの出欠データを読み込みました。変更したい日程をタップして上書き保存できます。"
            : "✨ 新規登録です。各日程の「◯ / △ / ✕」を選択して保存してください。"}
        </span>
      </div>

      <div class="form-group">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
          <label class="form-label">2. ${escapeHtml(sheet.monthLabel)}の全日程を一括選択</label>
          <div style="display: flex; gap: 4px;">
            <button type="button" class="btn-icon" data-fill-all="◯" style="font-size: 0.75rem; padding: 4px 8px;">すべて◯</button>
            <button type="button" class="btn-icon" data-fill-all="△" style="font-size: 0.75rem; padding: 4px 8px;">すべて△</button>
            <button type="button" class="btn-icon" data-fill-all="✕" style="font-size: 0.75rem; padding: 4px 8px;">すべて✕</button>
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px;" id="bulkDatesContainer">
          ${sheet.dates.map(d => {
            const currentMark = existing.marks[d.dateId] || "◯";
            return `
              <div class="bulk-date-row" data-date-row="${escapeHtml(d.dateId)}">
                <div class="bulk-date-info">
                  ${escapeHtml(d.dateLabel)}
                  <span class="bulk-date-sub">${escapeHtml(d.title)}</span>
                </div>
                <div class="mark-Segment" role="group" aria-label="${escapeHtml(d.dateLabel)}の出欠">
                  ${MARK_OPTIONS.map(mk => `
                    <button
                      type="button"
                      class="mark-radio-btn ${currentMark === mk ? "selected" : ""}"
                      data-date-id="${escapeHtml(d.dateId)}"
                      data-val="${mk}"
                    >${mk}</button>
                  `).join("")}
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="bulkComment">
          3. ひとことコメント（遅刻・早退の連絡など）
        </label>
        <input
          type="text"
          id="bulkComment"
          class="form-control"
          value="${escapeHtml(existing.comment || "")}"
          placeholder="例: 11/11は授業のため17:00から参加します"
        />
      </div>
    `;

    // メンバー変更時に既存の回答内容を即座に再読込
    document.getElementById("bulkMemberSelect").addEventListener("change", e => {
      renderBulkFormForMember(e.target.value);
    });

    // 個別の ◯ / △ / ✕ ボタン切替
    bodyEl.querySelectorAll(".mark-radio-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const dId = btn.dataset.dateId;
        bodyEl.querySelectorAll(`.mark-radio-btn[data-date-id="${dId}"]`).forEach(b => {
          b.classList.toggle("selected", b === btn);
        });
      });
    });

    // 「すべて◯ / △ / ✕」一括セットボタン
    bodyEl.querySelectorAll("[data-fill-all]").forEach(fillBtn => {
      fillBtn.addEventListener("click", () => {
        const targetVal = fillBtn.dataset.fillAll;
        bodyEl.querySelectorAll(".mark-radio-btn").forEach(b => {
          b.classList.toggle("selected", b.dataset.val === targetVal);
        });
      });
    });
  }

  renderBulkFormForMember(selectedSysId);
  modal.classList.add("open");
}

// 幹部向け：月・候補日の追加/削除モーダル
function openManageDatesModal() {
  state.modalMode = "manageDates";
  resetFormModalButtons(false);
  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");

  btnDelete.style.display = "none";
  const sheet = db.monthlySchedules[state.selectedMonth];
  titleEl.textContent = `⚙️ ${sheet.monthLabel} の候補日管理・新規月作成`;

  const defaultIsoDate = `${state.selectedMonth}-28`;

  bodyEl.innerHTML = `
    <div class="form-group">
      <label class="form-label">現在の候補日一覧（${escapeHtml(sheet.monthLabel)}）</label>
      <div style="display: flex; flex-direction: column; gap: 6px;" id="manageDateList">
        ${sheet.dates.map(d => `
          <div class="date-manage-item">
            <span><strong>${escapeHtml(d.dateLabel)}</strong> — ${escapeHtml(d.title)}</span>
            <button type="button" class="btn btn-danger" style="padding: 3px 8px; font-size: 0.75rem;" data-del-date="${escapeHtml(d.dateId)}">削除</button>
          </div>
        `).join("")}
      </div>
    </div>

    <hr style="border: none; border-top: 1px solid var(--border);" />

    <div class="form-group">
      <label class="form-label">＋ この月に新しい候補日（イベント）を追加</label>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        <input type="date" id="newDateIso" class="form-control" value="${escapeHtml(defaultIsoDate)}" />
        <input type="text" id="newDateTitle" class="form-control" placeholder="例: 模擬授業リハーサル" />
      </div>
      <span class="form-hint">※追加した日程は「イベント」タブにも自動的に登録・連携されます。</span>
      <button type="button" class="btn btn-secondary" id="btnAddCandidateDate" style="align-self: flex-start; margin-top: 4px;">
        ＋ 候補日を追加する
      </button>
    </div>

    <hr style="border: none; border-top: 1px solid var(--border);" />

    <div class="form-group">
      <label class="form-label">📅 新しい月の出欠表を作成</label>
      <div style="display: flex; gap: 8px; align-items: center;">
        <input type="month" id="newMonthInput" class="form-control" value="2027-01" style="max-width: 180px;" />
        <button type="button" class="btn btn-secondary" id="btnCreateNewMonth">新規月シートを作成</button>
      </div>
    </div>
  `;

  // 候補日削除（連動する「イベント」も削除）
  bodyEl.querySelectorAll("[data-del-date]").forEach(btn => {
    btn.addEventListener("click", () => {
      const dId = btn.dataset.delDate;
      const targetDateObj = sheet.dates.find(d => d.dateId === dId);
      if (targetDateObj && targetDateObj.eventSysId) {
        db.events = db.events.filter(ev => ev.sysId !== targetDateObj.eventSysId);
      }
      sheet.dates = sheet.dates.filter(d => d.dateId !== dId);
      if (sheet.responses) {
        Object.values(sheet.responses).forEach(resp => {
          if (resp.marks) delete resp.marks[dId];
        });
      }
      saveDb();
      openManageDatesModal();
      renderAttendanceView();
    });
  });

  // 候補日追加（「イベント」にも自動追加・対象月シートへ同期）
  document.getElementById("btnAddCandidateDate").addEventListener("click", () => {
    const isoDate = document.getElementById("newDateIso").value.trim();
    const title = document.getElementById("newDateTitle").value.trim() || "サークル活動";
    if (!isoDate) return;

    const targetYm = isoDate.slice(0, 7);
    const [y, m] = targetYm.split("-").map(Number);
    if (!db.monthlySchedules[targetYm]) {
      db.monthlySchedules[targetYm] = {
        monthKey: targetYm,
        monthLabel: `${y}年${m}月`,
        dates: [],
        responses: {}
      };
    }

    const newDateObj = {
      dateId: "d_" + generateUniqueId(),
      isoDate,
      dateLabel: formatDateLabelFromIso(isoDate, "17:30〜"),
      title
    };
    db.monthlySchedules[targetYm].dates.push(newDateObj);
    syncScheduleDateToEvents(targetYm, newDateObj);
    sortSheetDates(db.monthlySchedules[targetYm]);

    state.selectedMonth = targetYm;
    saveDb();
    openManageDatesModal();
    renderAttendanceView();
  });

  // 新規月作成（「イベント」にも自動連携）
  document.getElementById("btnCreateNewMonth").addEventListener("click", () => {
    const ym = document.getElementById("newMonthInput").value;
    if (!ym) return;
    if (!db.monthlySchedules[ym]) {
      const [y, m] = ym.split("-");
      const isoDate = `${ym}-10`;
      db.monthlySchedules[ym] = {
        monthKey: ym,
        monthLabel: `${y}年${Number(m)}月`,
        dates: [
          {
            dateId: "d_" + generateUniqueId(),
            isoDate,
            dateLabel: formatDateLabelFromIso(isoDate, "17:30〜"),
            title: "定例ミーティング"
          }
        ],
        responses: {}
      };
      syncMonthScheduleAndEvents(ym);
    }
    state.selectedMonth = ym;
    saveDb();
    closeFormModal();
    renderAttendanceView();
  });

  modal.classList.add("open");
}

// 通常の登録・編集モーダルを開く
function openFormModal(sysId = null) {
  if (state.currentView === "attendance") {
    openBulkAttendanceModal(null);
    return;
  }

  state.modalMode = "record";
  state.editingSysId = sysId;
  resetFormModalButtons(false);
  const modal = document.getElementById("formModal");
  const titleEl = document.getElementById("formModalTitle");
  const bodyEl = document.getElementById("formModalBody");
  const btnDelete = document.getElementById("btnDeleteRecord");

  btnDelete.style.display = sysId ? "inline-block" : "none";

  if (state.currentView === "members") {
    const rec = sysId
      ? db.members.find(m => m.sysId === sysId)
      : {
          studentId: "",
          name: "",
          role: "在校生",
          admissionYear: "2026年度",
          discordName: "",
          subjects: []
        };
    const selectedSubjects = Array.isArray(rec.subjects) ? rec.subjects : [];

    titleEl.textContent = sysId ? "メンバー情報の更新" : "メンバー登録（Googleフォーム準拠）";
    bodyEl.innerHTML = `
      <details class="privacy-box">
        <summary>【個人情報の取り扱いについて】（流通経済大学「教職の森」メンバー登録フォームより）</summary>
        <p style="margin-top: 6px;">
          ご記入いただく個人情報（氏名・学籍番号・希望教科など）は、「教職の森」における以下の活動および手続きのために収集いたします。<br>
          ・交流会、模擬授業会をはじめとするサークル諸活動の運営<br>
          ・活動の出欠確認および連絡 / メンバー名簿の管理<br>
          ・学内手続き・施設利用申請に伴う書類作成
        </p>
      </details>

      <div class="form-group">
        <label class="form-label" for="fieldStudentId">
          学籍番号 <span class="req-tag">必須 (Required)</span>
        </label>
        <input type="text" id="fieldStudentId" class="form-control" required value="${escapeHtml(rec.studentId || "")}" placeholder="例: 2601001" />
      </div>

      <div class="form-group">
        <label class="form-label" for="fieldName">
          氏名（名前） <span class="req-tag">必須 (Required)</span>
        </label>
        <input type="text" id="fieldName" class="form-control" required value="${escapeHtml(rec.name)}" placeholder="（例）流経　太郎" />
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <div class="form-group">
          <label class="form-label" for="fieldYear">
            入学年度 <span class="req-tag">必須</span>
          </label>
          <select id="fieldYear" class="form-control" required>
            ${YEAR_OPTIONS.map(y => `<option value="${y}" ${rec.admissionYear === y ? "selected" : ""}>${y}</option>`).join("")}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label" for="fieldRole">
            役職 <span class="ro-tag">RBAC権限に応じた選択制御</span>
          </label>
          <select id="fieldRole" class="form-control" ${!canAssignMemberRole(state.userRole, rec.role) ? "disabled title='現在のロールではこの上位役職を変更できません'" : ""}>
            ${ROLE_OPTIONS.map(r => {
              const allowed = canAssignMemberRole(state.userRole, r);
              const isCurrent = rec.role === r;
              return `<option value="${r}" ${isCurrent ? "selected" : ""} ${!allowed && !isCurrent ? "disabled" : ""}>${r}${!allowed ? "（変更権限なし）" : ""}</option>`;
            }).join("")}
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="fieldDiscord">
          Discordユーザー名 <span class="req-tag">必須 (Required)</span>
        </label>
        <input type="text" id="fieldDiscord" class="form-control" required value="${escapeHtml(rec.discordName || "")}" placeholder="例: ryukei_taro" />
      </div>

      <div class="form-group">
        <label class="form-label">
          希望教科 <span class="req-tag">必須・複数選択可 (EnumList)</span>
        </label>
        <div class="checkbox-grid" id="fieldSubjectsGroup">
          ${SUBJECT_OPTIONS.map(sub => `
            <label class="checkbox-item">
              <input
                type="checkbox"
                name="fieldSubjects"
                value="${escapeHtml(sub)}"
                ${selectedSubjects.includes(sub) ? "checked" : ""}
              />
              <span>${escapeHtml(sub)}</span>
            </label>
          `).join("")}
        </div>
        <span class="form-hint" id="subjectErrorHint" style="color: var(--danger); display: none;">※希望教科を1つ以上選択してください。</span>
      </div>

      <p class="form-hint">※「システムID」は自動付与され、SHOW? = false のため画面上には表示されません。</p>
    `;
  } else if (state.currentView === "tasks") {
    const nextTaskId = generateSequentialId("T", db.tasks.length);
    const rec = sysId
      ? db.tasks.find(t => t.sysId === sysId)
      : { taskId: nextTaskId, taskName: "", status: "未着手", assignee: "", dueDate: "", memo: "" };

    // 担当者候補リスト（登録メンバー名一覧 + 既存設定値）
    const memberNames = Array.from(new Set(db.members.map(m => m.name).filter(Boolean)));
    if (rec.assignee && !memberNames.includes(rec.assignee)) {
      memberNames.unshift(rec.assignee);
    }

    // 期限（YYYY-MM-DD）の分解
    let dueY = "";
    let dueM = "";
    let dueD = "";
    if (rec.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(rec.dueDate)) {
      const parts = rec.dueDate.split("-");
      dueY = String(Number(parts[0]));
      dueM = String(Number(parts[1]));
      dueD = String(Number(parts[2]));
    }
    const years = [2026, 2027, 2028, 2029, 2030];
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    const days = Array.from({ length: 31 }, (_, i) => i + 1);

    titleEl.textContent = sysId ? "タスクの編集" : "タスクの新規登録";
    bodyEl.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="fieldTaskId">
          タスクID <span class="ro-tag">自動割り当て</span>
        </label>
        <input type="text" id="fieldTaskId" class="form-control" readonly value="${escapeHtml(rec.taskId)}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="fieldTaskName">
          タスク名 <span class="req-tag">必須 (Required)</span>
        </label>
        <input type="text" id="fieldTaskName" class="form-control" required value="${escapeHtml(rec.taskName)}" placeholder="例: 新歓ガイダンス資料の印刷" />
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <div class="form-group">
          <label class="form-label" for="fieldStatus">
            進捗
          </label>
          <select id="fieldStatus" class="form-control">
            ${STATUS_OPTIONS.map(s => `<option value="${s}" ${rec.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="fieldTaskAssignee">
            担当者 <span class="ro-tag">任意</span>
          </label>
          <select id="fieldTaskAssignee" class="form-control">
            <option value="">未設定（担当者なし）</option>
            ${memberNames.map(name => `<option value="${escapeHtml(name)}" ${rec.assignee === name ? "selected" : ""}>👤 ${escapeHtml(name)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-group">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <label class="form-label" for="fieldTaskDueYear">
            期限 <span class="ro-tag">任意（プルダウン選択）</span>
          </label>
          <button type="button" class="btn-icon" id="btnClearTaskDue" style="padding: 2px 8px; font-size: 0.74rem;">
            期限なしに戻す
          </button>
        </div>
        <div style="display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 8px;">
          <select id="fieldTaskDueYear" class="form-control" aria-label="期限（年）">
            <option value="">年（未設定）</option>
            ${years.map(y => `<option value="${y}" ${String(y) === dueY ? "selected" : ""}>${y}年</option>`).join("")}
          </select>
          <select id="fieldTaskDueMonth" class="form-control" aria-label="期限（月）">
            <option value="">月（未設定）</option>
            ${months.map(m => `<option value="${m}" ${String(m) === dueM ? "selected" : ""}>${m}月</option>`).join("")}
          </select>
          <select id="fieldTaskDueDay" class="form-control" aria-label="期限（日）">
            <option value="">日（未設定）</option>
            ${days.map(d => `<option value="${d}" ${String(d) === dueD ? "selected" : ""}>${d}日</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="fieldTaskMemo">
          メモ <span class="ro-tag">任意</span>
        </label>
        <textarea id="fieldTaskMemo" class="form-control" rows="3" placeholder="タスクの詳細・引き継ぎ事項・関連リンクなどを記入（任意）">${escapeHtml(rec.memo || "")}</textarea>
      </div>
    `;

    const selY = document.getElementById("fieldTaskDueYear");
    const selM = document.getElementById("fieldTaskDueMonth");
    const selD = document.getElementById("fieldTaskDueDay");
    const syncPullDownDefaults = changedEl => {
      if (changedEl === selY && !selY.value) {
        selM.value = "";
        selD.value = "";
        return;
      }
      if (changedEl.value) {
        const now = new Date();
        if (!selY.value) selY.value = String(now.getFullYear());
        if (!selM.value) selM.value = String(now.getMonth() + 1);
        if (!selD.value) selD.value = String(now.getDate());
      }
    };
    selY?.addEventListener("change", () => syncPullDownDefaults(selY));
    selM?.addEventListener("change", () => syncPullDownDefaults(selM));
    selD?.addEventListener("change", () => syncPullDownDefaults(selD));
    document.getElementById("btnClearTaskDue")?.addEventListener("click", () => {
      if (selY) selY.value = "";
      if (selM) selM.value = "";
      if (selD) selD.value = "";
    });
  } else if (state.currentView === "events") {
    const nextEventId = generateNextEventId(db.events);
    const rec = sysId
      ? db.events.find(ev => ev.sysId === sysId)
      : { eventId: nextEventId, eventName: "", eventDate: "", status: "開催" };
    const currentStatus = getAutoEventStatus(rec);

    titleEl.textContent = sysId ? "イベント企画の編集" : "イベント企画の新規登録";
    bodyEl.innerHTML = `
      <div class="form-group">
        <label class="form-label" for="fieldEventId">
          イベントID <span class="ro-tag">自動割り当て</span>
        </label>
        <input type="text" id="fieldEventId" class="form-control" readonly value="${escapeHtml(rec.eventId)}" />
      </div>
      <div class="form-group">
        <label class="form-label" for="fieldEventName">
          イベント名 <span class="req-tag">必須 (Required)</span>
        </label>
        <input type="text" id="fieldEventName" class="form-control" required value="${escapeHtml(rec.eventName)}" placeholder="例: 第2回 模擬授業対策会" />
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <div class="form-group">
          <label class="form-label" for="fieldEventDate">
            開催日 <span class="ro-tag">任意 (Date)</span>
          </label>
          <input type="date" id="fieldEventDate" class="form-control" value="${escapeHtml(rec.eventDate || "")}" />
        </div>
        <div class="form-group">
          <label class="form-label" for="fieldEventStatus">
            ステータス <span class="ro-tag">日付超過で自動終了</span>
          </label>
          <select id="fieldEventStatus" class="form-control">
            ${EVENT_STATUS_OPTIONS.map(s => `<option value="${s}" ${currentStatus === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
      </div>
      <span class="form-hint">※開催日を設定すると「出欠調整」タブの該当月の日程にも自動反映され、開催日を過ぎるとステータスが自動で「終了」に切り替わります。</span>
    `;
    document.getElementById("fieldEventDate")?.addEventListener("change", e => {
      const val = e.target.value;
      const statusSel = document.getElementById("fieldEventStatus");
      if (val && statusSel) {
        statusSel.value = val < getTodayIsoString() ? "終了" : "開催";
      }
    });
  }

  modal.classList.add("open");
}

function closeFormModal() {
  document.getElementById("formModal").classList.remove("open");
  state.editingSysId = null;
}

// スプレッドシートDBプレビュー＆CSV出力
function renderDbTable() {
  const container = document.getElementById("dbTableContainer");
  const sheet = state.activeDbSheet;

  if (sheet === "members") {
    container.innerHTML = `
      <table class="db-table">
        <thead>
          <tr>
            <th>システムID <span class="col-hidden-tag">SHOW?=false</span></th>
            <th>学籍番号</th>
            <th>氏名（名前）</th>
            <th>役職</th>
            <th>入学年度</th>
            <th>Discordユーザー名</th>
            <th>希望教科 <span class="col-hidden-tag">EnumList</span></th>
          </tr>
        </thead>
        <tbody>
          ${db.members.map(m => `
            <tr>
              <td style="font-family: monospace; color: #64748b;">${escapeHtml(m.sysId)}</td>
              <td style="font-family: monospace;">${escapeHtml(m.studentId || "")}</td>
              <td>${escapeHtml(m.name)}</td>
              <td>${escapeHtml(m.role)}</td>
              <td>${escapeHtml(m.admissionYear)}</td>
              <td>${escapeHtml(m.discordName || "")}</td>
              <td>${escapeHtml((m.subjects || []).join(", "))}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } else if (sheet === "tasks") {
    container.innerHTML = `
      <table class="db-table">
        <thead>
          <tr>
            <th>システムID <span class="col-hidden-tag">SHOW?=false</span></th>
            <th>タスクID</th>
            <th>進捗</th>
            <th>タスク名</th>
            <th>担当者</th>
            <th>期限</th>
            <th>メモ</th>
          </tr>
        </thead>
        <tbody>
          ${db.tasks.map(t => `
            <tr>
              <td style="font-family: monospace; color: #64748b;">${escapeHtml(t.sysId)}</td>
              <td>${escapeHtml(t.taskId)}</td>
              <td>${escapeHtml(t.status)}</td>
              <td>${escapeHtml(t.taskName)}</td>
              <td>${escapeHtml(t.assignee || "")}</td>
              <td>${escapeHtml(t.dueDate || "")}</td>
              <td>${escapeHtml(t.memo || "")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  } else if (sheet === "events") {
    refreshAllEventStatuses(db.events);
    container.innerHTML = `
      <table class="db-table">
        <thead>
          <tr>
            <th>システムID <span class="col-hidden-tag">SHOW?=false</span></th>
            <th>イベントID</th>
            <th>イベント名</th>
            <th>開催日</th>
            <th>ステータス</th>
          </tr>
        </thead>
        <tbody>
          ${db.events.map(ev => {
            const evStatus = getAutoEventStatus(ev);
            return `
              <tr>
                <td style="font-family: monospace; color: #64748b;">${escapeHtml(ev.sysId)}</td>
                <td>${escapeHtml(ev.eventId)}</td>
                <td>${escapeHtml(ev.eventName)}</td>
                <td>${escapeHtml(ev.eventDate || "")}</td>
                <td>${escapeHtml(evStatus)}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  } else if (sheet === "attendance") {
    const mSheet = db.monthlySchedules[state.selectedMonth];
    const dates = mSheet ? mSheet.dates : [];
    const responses = mSheet ? mSheet.responses : {};
    container.innerHTML = `
      <table class="db-table">
        <thead>
          <tr>
            <th>対象月</th>
            <th>学籍番号</th>
            <th>氏名</th>
            ${dates.map(d => `<th>${escapeHtml(d.dateLabel)}</th>`).join("")}
            <th>コメント</th>
          </tr>
        </thead>
        <tbody>
          ${db.members.map(m => {
            const resp = responses[m.sysId] || { marks: {}, comment: "" };
            return `
              <tr>
                <td>${escapeHtml(mSheet ? mSheet.monthLabel : "")}</td>
                <td style="font-family: monospace;">${escapeHtml(m.studentId || "")}</td>
                <td>${escapeHtml(m.name)}</td>
                ${dates.map(d => `<td>${escapeHtml(resp.marks[d.dateId] || "未回答")}</td>`).join("")}
                <td>${escapeHtml(resp.comment || "")}</td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  }
}

function downloadCurrentSheetCsv() {
  const sheet = state.activeDbSheet;
  let headers = [];
  let rows = [];
  let filename = "";

  if (sheet === "members") {
    headers = ["システムID", "学籍番号", "氏名", "役職", "入学年度", "Discordユーザー名", "希望教科"];
    rows = db.members.map(m => [
      m.sysId,
      m.studentId || "",
      m.name,
      m.role,
      m.admissionYear,
      m.discordName || "",
      (m.subjects || []).join(", ")
    ]);
    filename = "教職の森_運営管理アプリDB_メンバー.csv";
  } else if (sheet === "tasks") {
    headers = ["システムID", "タスクID", "進捗", "タスク名", "担当者", "期限", "メモ"];
    rows = db.tasks.map(t => [
      t.sysId,
      t.taskId,
      t.status,
      t.taskName,
      t.assignee || "",
      t.dueDate || "",
      t.memo || ""
    ]);
    filename = "教職の森_運営管理アプリDB_タスク.csv";
  } else if (sheet === "events") {
    refreshAllEventStatuses(db.events);
    headers = ["システムID", "イベントID", "イベント名", "開催日", "ステータス"];
    rows = db.events.map(ev => [ev.sysId, ev.eventId, ev.eventName, ev.eventDate || "", getAutoEventStatus(ev)]);
    filename = "教職の森_運営管理アプリDB_イベント.csv";
  } else {
    const mSheet = db.monthlySchedules[state.selectedMonth];
    const dates = mSheet ? mSheet.dates : [];
    const responses = mSheet ? mSheet.responses : {};
    headers = ["対象月", "学籍番号", "氏名", ...dates.map(d => `${d.dateLabel} ${d.title}`), "コメント"];
    rows = db.members.map(m => {
      const resp = responses[m.sysId] || { marks: {}, comment: "" };
      return [
        mSheet ? mSheet.monthLabel : "",
        m.studentId || "",
        m.name,
        ...dates.map(d => resp.marks[d.dateId] || "未回答"),
        resp.comment || ""
      ];
    });
    filename = `教職の森_運営管理アプリDB_月別出欠_${state.selectedMonth}.csv`;
  }

  const csvCell = val => `"${String(val ?? "").replace(/"/g, '""')}"`;
  const csvContent =
    "\uFEFF" +
    [headers.map(csvCell).join(","), ...rows.map(r => r.map(csvCell).join(","))].join("\r\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function openSyncModal() {
  const syncModal = document.getElementById("syncModal");
  const urlInput = document.getElementById("sheetUrlInput");
  const statusEl = document.getElementById("syncStatusMsg");
  if (urlInput) urlInput.value = db.sheetSyncUrl || "";
  if (statusEl) {
    statusEl.style.color = "var(--text-muted)";
    statusEl.textContent = db.lastSyncedAt ? `最終同期日時: ${db.lastSyncedAt}` : "";
  }
  syncModal?.classList.add("open");
}

function closeSyncModal() {
  document.getElementById("syncModal")?.classList.remove("open");
}

// 初期化処理
document.addEventListener("DOMContentLoaded", () => {
  // スマホ画面 / PCワイド画面 切替スイッチ
  document.querySelectorAll(".preview-mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const isMobile = btn.dataset.device === "mobile";
      document.body.classList.toggle("mobile-preview-mode", isMobile);
      document.querySelectorAll(".preview-mode-btn").forEach(b => {
        b.classList.toggle("active", b === btn);
      });
    });
  });

  // 下部ナビゲーション切替
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      state.currentView = btn.dataset.view;
      state.searchQuery = "";
      document.getElementById("searchInput").value = "";
      renderFilters();
      renderView();
    });
  });

  // イベント表示形式（Deck / List）切替
  document.querySelectorAll("#eventsViewToggleWrap .view-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.eventsLayout = btn.dataset.layout;
      document
        .querySelectorAll("#eventsViewToggleWrap .view-toggle-btn")
        .forEach(b => b.classList.toggle("active", b.dataset.layout === state.eventsLayout));
      renderView();
    });
  });

  // 検索ボックス
  document.getElementById("searchInput").addEventListener("input", e => {
    state.searchQuery = e.target.value;
    renderView();
  });

  // FAB（新規追加ボタン：メンバー画面ではGoogleフォームへジャンプ）
  document.getElementById("btnAddRecord").addEventListener("click", () => {
    if (state.currentView === "members") {
      window.open(GOOGLE_FORM_URL, "_blank", "noopener,noreferrer");
      return;
    }
    openFormModal(null);
  });

  // フォームモーダル閉じる
  document.getElementById("btnCloseFormModal").addEventListener("click", closeFormModal);
  document.getElementById("btnCancelForm").addEventListener("click", closeFormModal);

  // 詳細モーダル右上の「✏️ 編集」ボタンから編集フォームへ切り替え
  document.getElementById("btnSwitchToEdit")?.addEventListener("click", () => {
    if (state.editingSysId) {
      openFormModal(state.editingSysId);
    }
  });

  // フォーム保存処理
  document.getElementById("recordForm").addEventListener("submit", e => {
    e.preventDefault();

    // 調整さん方式の一括出欠登録・上書き変更モード
    if (state.modalMode === "bulkAttendance") {
      const sheet = db.monthlySchedules[state.selectedMonth];
      const memberSysId = document.getElementById("bulkMemberSelect").value;
      const comment = document.getElementById("bulkComment").value.trim();
      const marks = {};

      sheet.dates.forEach(d => {
        const selectedBtn = document.querySelector(
          `.mark-radio-btn.selected[data-date-id="${d.dateId}"]`
        );
        marks[d.dateId] = selectedBtn ? selectedBtn.dataset.val : "◯";
      });

      sheet.responses[memberSysId] = { marks, comment };
      saveDb();
      closeFormModal();
      renderAttendanceView();
      return;
    }

    if (state.modalMode === "addMonth") {
      const y = Number(document.getElementById("addMonthYear").value);
      const m = Number(document.getElementById("addMonthNum").value);
      const ym = `${y}-${String(m).padStart(2, "0")}`;

      if (db.monthlySchedules[ym]) {
        alert(`${y}年${m}月の出欠表はすでに存在します。対象月を切り替えます。`);
        state.selectedMonth = ym;
        closeFormModal();
        renderAttendanceView();
        return;
      }

      const selectedDays = Array.from(
        document.querySelectorAll('input[name="addMonthWeekdays"]:checked')
      ).map(cb => Number(cb.value));

      let candidateDates = [];
      if (selectedDays.length > 0) {
        candidateDates = generateWeekdayDatesForMonth(y, m, selectedDays, "17:30〜");
      } else {
        const isoDate = `${ym}-10`;
        candidateDates = [
          {
            dateId: "d_" + generateUniqueId(),
            isoDate,
            dateLabel: formatDateLabelFromIso(isoDate, "17:30〜"),
            title: "定例ミーティング"
          }
        ];
      }

      // ステップ2（追加する日程をリスト表示してチェックボックスで選択する画面）へ遷移
      openConfirmMonthDatesModal(y, m, ym, candidateDates);
      return;
    }

    if (state.modalMode === "confirmMonthDates") {
      const pending = state.pendingAddMonthData;
      if (!pending) {
        closeFormModal();
        return;
      }

      const checkedBoxes = Array.from(
        document.querySelectorAll('input[name="confirmMonthDateItem"]:checked')
      );

      if (checkedBoxes.length === 0) {
        const errEl = document.getElementById("confirmDateErrorHint");
        if (errEl) errEl.style.display = "block";
        return;
      }

      const selectedDates = checkedBoxes.map(cb => {
        const idx = Number(cb.value);
        const orig = pending.candidateDates[idx];
        const titleInput = document.querySelector(`[data-candidate-title="${idx}"]`);
        const customTitle = titleInput ? titleInput.value.trim() : "";
        return {
          ...orig,
          title: customTitle || orig.title || "定例活動・模擬授業会"
        };
      });

      db.monthlySchedules[pending.ym] = {
        monthKey: pending.ym,
        monthLabel: `${pending.y}年${pending.m}月`,
        dates: selectedDates,
        responses: {}
      };

      // 選択された候補日を「イベント」へ自動追加＆同月の既存イベントも出欠表に反映
      syncMonthScheduleAndEvents(pending.ym);

      state.selectedMonth = pending.ym;
      state.pendingAddMonthData = null;
      saveDb();
      closeFormModal();
      renderAttendanceView();
      return;
    }

    if (state.modalMode === "manageDates") {
      closeFormModal();
      return;
    }

    const sysId = state.editingSysId;

    if (state.currentView === "members") {
      const studentId = document.getElementById("fieldStudentId").value.trim();
      const name = document.getElementById("fieldName").value.trim();
      const role = document.getElementById("fieldRole").value;
      const admissionYear = document.getElementById("fieldYear").value;
      const discordName = document.getElementById("fieldDiscord").value.trim();
      const checkedSubjects = Array.from(
        document.querySelectorAll('input[name="fieldSubjects"]:checked')
      ).map(cb => cb.value);

      if (checkedSubjects.length === 0) {
        const errHint = document.getElementById("subjectErrorHint");
        if (errHint) errHint.style.display = "block";
        return;
      }

      if (!studentId || !name || !discordName) return;

      if (sysId) {
        const target = db.members.find(m => m.sysId === sysId);
        if (target) {
          target.studentId = studentId;
          target.name = name;
          target.role = role;
          target.admissionYear = admissionYear;
          target.discordName = discordName;
          target.subjects = checkedSubjects;
        }
      } else {
        db.members.push({
          sysId: generateUniqueId(),
          studentId,
          name,
          role,
          admissionYear,
          discordName,
          subjects: checkedSubjects
        });
      }
    } else if (state.currentView === "tasks") {
      const taskId = document.getElementById("fieldTaskId").value;
      const taskName = document.getElementById("fieldTaskName").value.trim();
      const status = document.getElementById("fieldStatus").value;
      const assignee = (document.getElementById("fieldTaskAssignee")?.value || "").trim();
      const dueY = document.getElementById("fieldTaskDueYear")?.value || "";
      const dueM = document.getElementById("fieldTaskDueMonth")?.value || "";
      const dueD = document.getElementById("fieldTaskDueDay")?.value || "";
      let dueDate = "";
      if (dueY && dueM && dueD) {
        const maxDay = new Date(Number(dueY), Number(dueM), 0).getDate();
        const validDay = Math.min(Number(dueD), maxDay);
        dueDate = `${dueY}-${String(dueM).padStart(2, "0")}-${String(validDay).padStart(2, "0")}`;
      }
      const memo = (document.getElementById("fieldTaskMemo")?.value || "").trim();
      if (!taskName) return;

      if (sysId) {
        const target = db.tasks.find(t => t.sysId === sysId);
        if (target) {
          target.taskName = taskName;
          target.status = status;
          target.assignee = assignee;
          target.dueDate = dueDate;
          target.memo = memo;
        }
      } else {
        db.tasks.push({
          sysId: generateUniqueId(),
          taskId,
          taskName,
          status,
          assignee,
          dueDate,
          memo
        });
      }
    } else if (state.currentView === "events") {
      const eventId = document.getElementById("fieldEventId").value;
      const eventName = document.getElementById("fieldEventName").value.trim();
      const eventDate = document.getElementById("fieldEventDate").value.trim();
      const manualStatus = document.getElementById("fieldEventStatus")?.value || "開催";
      if (!eventName) return;

      // 開催日が過去の場合は自動で「終了」、それ以外は選択値（デフォルト「開催」）
      const computedStatus =
        eventDate && /^\d{4}-\d{2}-\d{2}$/.test(eventDate) && eventDate < getTodayIsoString()
          ? "終了"
          : manualStatus;

      if (sysId) {
        const target = db.events.find(ev => ev.sysId === sysId);
        if (target) {
          const previousDate = target.eventDate || "";
          target.eventName = eventName;
          target.eventDate = eventDate;
          target.status = computedStatus;
          syncEventToMonthlySchedule(target, previousDate);
        }
      } else {
        const newEv = {
          sysId: "e_" + generateUniqueId(),
          eventId,
          eventName,
          eventDate,
          status: computedStatus
        };
        db.events.push(newEv);
        syncEventToMonthlySchedule(newEv, null);
      }
    }

    saveDb();
    closeFormModal();
    renderView();
  });

  // レコード削除処理（編集モーダル内）
  document.getElementById("btnDeleteRecord").addEventListener("click", () => {
    const sysId = state.editingSysId;
    if (!sysId) return;
    if (!confirm("このデータを削除してもよろしいですか？")) return;

    deleteRecordById(state.currentView, sysId);
    closeFormModal();
    renderView();
  });

  // 表示中タブのデータを一括削除するボタン
  document.getElementById("btnClearCurrentTab").addEventListener("click", () => {
    if (state.currentView === "members") {
      if (!confirm(`現在登録されているメンバー（${db.members.length}名）をすべて削除して空にしますか？`)) return;
      db.members = [];
      Object.values(db.monthlySchedules || {}).forEach(sheet => {
        sheet.responses = {};
      });
    } else if (state.currentView === "tasks") {
      if (!confirm(`現在登録されているタスク（${db.tasks.length}件）をすべて削除して空にしますか？`)) return;
      db.tasks = [];
    } else if (state.currentView === "events") {
      if (!confirm(`現在登録されているイベント（${db.events.length}件）をすべて削除して空にしますか？`)) return;
      db.events.forEach(ev => removeEventFromMonthlySchedule(ev.sysId));
      db.events = [];
    } else if (state.currentView === "attendance") {
      const sheet = db.monthlySchedules[state.selectedMonth];
      if (!sheet) return;
      if (!confirm(`${sheet.monthLabel}の出欠回答データをすべてリセットしますか？`)) return;
      sheet.responses = {};
    }
    saveDb();
    renderFilters();
    renderView();
  });

  // Googleフォーム / スプレッドシート連携モーダル
  document.getElementById("btnOpenSyncModal")?.addEventListener("click", openSyncModal);
  document.getElementById("btnCloseSyncModal")?.addEventListener("click", closeSyncModal);
  document.getElementById("btnCloseSyncModalFooter")?.addEventListener("click", closeSyncModal);

  document.getElementById("btnSyncFromSheetUrl")?.addEventListener("click", () => {
    const rawUrl = document.getElementById("sheetUrlInput").value.trim();
    if (!rawUrl) {
      alert("GoogleスプレッドシートのURLを入力してください。");
      return;
    }
    syncFromGoogleSheetUrl(rawUrl, false);
  });

  document.getElementById("btnImportCsvFile")?.addEventListener("click", () => {
    const fileInput = document.getElementById("csvFileInput");
    const file = fileInput?.files?.[0];
    if (!file) {
      alert("取り込むCSVファイルを選択してください。");
      return;
    }
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const result = mergeMembersFromCsvText(String(ev.target.result || ""));
        renderFilters();
        renderView();
        alert(`CSV取り込み完了！\n新規追加: ${result.addedCount}名 / 更新: ${result.updatedCount}名`);
        closeSyncModal();
      } catch (err) {
        alert(`CSV取り込みエラー: ${err.message}`);
      }
    };
    reader.readAsText(file, "UTF-8");
  });

  // 別タブ（Googleフォーム）から戻ってきたときにスプレッドシートURLが設定済みなら自動同期
  window.addEventListener("focus", () => {
    if (db.sheetSyncUrl) {
      syncFromGoogleSheetUrl(db.sheetSyncUrl, true);
    }
  });

  // DB構造プレビューモーダル
  const dbModal = document.getElementById("dbModal");
  document.getElementById("btnOpenDbModal").addEventListener("click", () => {
    state.activeDbSheet = state.currentView;
    document.querySelectorAll("#dbSheetTabs .view-toggle-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.sheet === state.activeDbSheet);
    });
    renderDbTable();
    dbModal.classList.add("open");
  });

  document.getElementById("btnCloseDbModal").addEventListener("click", () => {
    dbModal.classList.remove("open");
  });
  document.getElementById("btnCloseDbModalFooter").addEventListener("click", () => {
    dbModal.classList.remove("open");
  });

  document.querySelectorAll("#dbSheetTabs .view-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.activeDbSheet = btn.dataset.sheet;
      document.querySelectorAll("#dbSheetTabs .view-toggle-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.sheet === state.activeDbSheet);
      });
      renderDbTable();
    });
  });

  document.getElementById("btnDownloadCsv").addEventListener("click", downloadCurrentSheetCsv);

  // 上部バーのRBACロール切替セレクター（検証・デモ用）
  document.getElementById("rbacRoleSwitcher")?.addEventListener("change", e => {
    const selectedRole = e.target.value;
    applyRbacUi(selectedRole);
    renderFilters();
    renderView();
  });

  // Googleログインボタン
  document.getElementById("btnGoogleAuth")?.addEventListener("click", () => {
    if (state.currentUser) {
      signOutUser();
    } else {
      signInWithGoogle();
    }
  });

  // 起動時に Supabase の profiles テーブルから自分の role を取得し、RBAC UI制御を適用
  fetchCurrentUserRole().then(role => {
    applyRbacUi(role);
    renderFilters();
    renderView();
    if (db.sheetSyncUrl && hasPermission(state.userRole, "membersView")) {
      syncFromGoogleSheetUrl(db.sheetSyncUrl, true);
    }
  });
});