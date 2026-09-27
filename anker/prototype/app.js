const app = document.querySelector("#app");

const demoState = {
  screen: "onboarding",
  onboardingStarted: false,
  onboardingStep: 0,
  activeScope: "story",
  activeStageId: "university",
  activeStoryId: "study-character",
  pendingStoryResult: false,
  callChecklistOpen: false,
  callPaused: false,
  editVoiceActive: false,
  deletedStageIds: [],
};

const coreInterviewSections = [
  {
    label: "基本身份与称呼",
    detail: "你是谁、希望怎样被称呼",
    prompt: "为了先认识你，你希望我怎么称呼你？",
  },
  {
    label: "成长背景与家庭",
    detail: "在哪里长大、和谁一起生活",
    prompt: "你小时候主要在哪里长大？那时和谁一起生活？",
  },
  {
    label: "求学经历",
    detail: "上学、离家和重要同学",
    prompt: "回想你的求学经历，哪一段最值得从头讲讲？",
  },
  {
    label: "工作与重要转折",
    detail: "职业主线和改变方向的事情",
    prompt: "你后来是怎样走上现在这条工作道路的？中间有什么转折？",
  },
  {
    label: "当前生活与重要故事",
    detail: "现在的生活、重要人物和想留下的故事",
    prompt: "如果只留下几件人生故事，你觉得现在最想先讲哪一件？",
  },
];

const profile = {
  name: "郭玉兴",
  birth: "1963 年 2 月 1 日",
  origin: "山东省日照市莒县",
  location: "天津市滨海新区中新生态城",
  occupation: "工艺工程师",
  work: "曾任职于天津水泥工业设计研究院",
  family: "罗志兰 · 郭伟航 · 秋果 · 橙橙",
};

const stageCatalog = [
  {
    id: "childhood",
    title: "故土与童年",
    years: "1963—1971",
    featured: false,
    summary: "山东莒县后岭村，土坯房、井水、煤油灯和一家人的勤俭生活，是后来性格和求学道路的起点。",
    prompt: "回到后岭村的童年，哪一个画面最先浮现在你脑子里？",
    stories: ["village-origin", "black-nose", "mother-support", "new-year"],
  },
  {
    id: "primary",
    title: "小学与初中",
    years: "1971—1978",
    featured: false,
    summary: "从大官庄小学到初中，捡鸡粪和蝉蜕、冬天围火堆、同学互助，以及一次危险涵洞经历。",
    prompt: "小学和初中那几年，有没有一件小事让你一直记到现在？",
    stories: ["schoolyard-work", "winter-fire", "cave-crossing"],
  },
  {
    id: "high-school",
    title: "高中",
    years: "1978—1983",
    featured: false,
    summary: "从店子集公社中学到莒县一中住校，在地瓜干和馒头之间坚持学习，也遇到改变自己的老师和成绩节点。",
    prompt: "住校读高中时，什么事情让你感到自己真的在往前走？",
    stories: ["boarding-school", "chemistry-99-5", "teacher-wang", "after-exam"],
  },
  {
    id: "university",
    title: "大学时期",
    years: "1983—1987",
    featured: true,
    summary: "山东建筑材料工业学院博山院区四年：第一次离家、五人寝室、元宵灯会、专业认同、朋友和毕业分配。",
    prompt: "1983 年第一次离开家去博山上大学，最先浮现在你脑子里的画面是什么？",
    stories: ["first-departure", "dorm-five", "lantern-festival", "hospital-friendship", "graduation-choice", "study-character"],
  },
  {
    id: "career",
    title: "职业生涯",
    years: "1987—退休",
    featured: false,
    summary: "从技术员、助理工程师到教授级高级工程师与技术总监，围绕水泥工艺设计、调试和传承走过一生。",
    prompt: "1987 年从邯郸实习回院后，哪一刻让你意识到自己真正进入了设计工作？",
    stories: ["handan-practice", "design-basic", "commissioning", "standards-research", "mentor-young-designers"],
  },
  {
    id: "retirement",
    title: "家庭、退休与人生寄语",
    years: "待展开",
    featured: false,
    summary: "关于夫妻、子女、孙辈、退休后的生活，以及想留给晚辈的人生话。",
    prompt: "如果把现在的生活讲给秋果和橙橙听，你最想先留下哪句话？",
    stories: ["family-life", "retirement", "message-to-young"],
  },
];

const storyCatalog = {
  "village-origin": {
    title: "后岭村的来历与郭氏家族",
    stageId: "childhood",
    status: "ready",
    summary: "从山东莒县后岭村讲起，故土和家族生活构成了人生最早的底色。",
    followups: ["后岭村这个名字的来历。", "家里当时的生活分工和日常。"],
    source: "补充材料 · 故土与童年",
  },
  "black-nose": {
    title: "黑鼻孔与煤油灯",
    stageId: "childhood",
    status: "collecting",
    summary: "关于土坯房、井水、煤油灯和童年生活质感的一组记忆线索。",
    followups: ["黑鼻孔这个称呼是怎么来的？", "煤油灯下最常发生什么？"],
    source: "补充材料 · 故土与童年 · 待确认",
  },
  "mother-support": {
    title: "母亲的支持与咸菜疙瘩",
    stageId: "childhood",
    status: "collecting",
    summary: "母亲的支持和家里的朴素生活，后来成为求学路上持续向前的力量。",
    followups: ["母亲当时具体怎样支持你？", "咸菜疙瘩对应的是哪一段生活？"],
    source: "补充材料 · 故土与童年 · 待确认",
  },
  "new-year": {
    title: "盼过年：煎饼、炸鸡与拜年",
    stageId: "childhood",
    status: "collecting",
    summary: "盼过年、吃煎饼和炸鸡、磕头拜年，是童年里带着家庭温度的节日记忆。",
    followups: ["小时候最盼过年的哪一天？", "当时家里怎样准备过年？"],
    source: "补充材料 · 故土与童年 · 待确认",
  },
  "schoolyard-work": {
    title: "捡鸡粪与蝉蜕",
    stageId: "primary",
    status: "collecting",
    summary: "大官庄小学时期，学习和乡村生活劳动交织在一起。",
    followups: ["捡鸡粪和蝉蜕是在什么情况下？", "那时你最喜欢哪门课？"],
    source: "补充材料 · 小学与初中",
  },
  "winter-fire": {
    title: "冬天围在火堆旁",
    stageId: "primary",
    status: "collecting",
    summary: "冬天的学校、火堆和同学之间的互助，是初中阶段很具体的生活画面。",
    followups: ["火堆旁通常会聊什么？", "那时同学之间怎样互相帮助？"],
    source: "补充材料 · 小学与初中",
  },
  "cave-crossing": {
    title: "危险涵洞",
    stageId: "primary",
    status: "collecting",
    summary: "一次经过危险涵洞的经历，留下了少年时期对环境和安全的直接感受。",
    followups: ["这次经历发生在什么时候？", "后来你怎么看待这件事？"],
    source: "补充材料 · 小学与初中 · 待确认",
  },
  "boarding-school": {
    title: "地瓜干换馒头的住校生活",
    stageId: "high-school",
    status: "collecting",
    summary: "莒县一中住校期间，在地瓜干和馒头之间坚持读书，母亲也会带来咸菜肉丝。",
    followups: ["住校时一天通常怎么过？", "母亲送咸菜肉丝是哪一次？"],
    source: "补充材料 · 高中",
  },
  "chemistry-99-5": {
    title: "99.5 分的化学答卷",
    stageId: "high-school",
    status: "ready",
    summary: "一次 99.5 分的化学答卷，让学习能力和坚持被老师、同学看见。",
    followups: ["那次答卷为什么印象这么深？", "成绩对当时的你意味着什么？"],
    source: "补充材料 · 高中",
  },
  "teacher-wang": {
    title: "王明晨老师",
    stageId: "high-school",
    status: "collecting",
    summary: "王明晨老师和全校第一的经历，构成高中阶段的重要学习记忆。",
    followups: ["王老师具体做过什么？", "全校第一之后你有什么变化？"],
    source: "补充材料 · 高中 · 待确认",
  },
  "after-exam": {
    title: "高考后的澡堂与《少林寺》",
    stageId: "high-school",
    status: "collecting",
    summary: "高考结束后的澡堂和电影《少林寺》，是紧张学习之后难得的放松画面。",
    followups: ["那天和谁一起去的？", "看电影时最记得哪个瞬间？"],
    source: "补充材料 · 高中",
  },
  "first-departure": {
    title: "博山山城下的七小时长途",
    stageId: "university",
    status: "ready",
    summary: "1983 年第一次离开家去博山，约 200 公里的路程坐了 7 个小时，是大学生活真正开始的画面。",
    followups: ["第一次到博山时，哪一个画面最让你陌生？", "这段路后来怎样影响你对离家的理解？"],
    source: "补充材料 · 大学时期 · LifeStage 访谈",
  },
  "dorm-five": {
    title: "寝室五人：彻夜长谈与晨跑",
    stageId: "university",
    status: "ready",
    summary: "五位来自北京、河北、河南、湖南、山东的同学，在寝室彻夜长谈，第二天一起晨跑。",
    followups: ["五个人最常聊什么？", "四年后这段友情留下了什么？"],
    source: "补充材料 · 大学时期 · LifeStage 访谈",
  },
  "lantern-festival": {
    title: "博山元宵灯会",
    stageId: "university",
    status: "ready",
    summary: "河边、灯会和街道的人流，是第一次在博山过元宵留下的城市记忆。",
    followups: ["当时和谁一起去看的？", "那一晚最难忘的画面是什么？"],
    source: "补充材料 · 大学时期 · LifeStage 访谈",
  },
  "hospital-friendship": {
    title: "部队医院里的军装友谊",
    stageId: "university",
    status: "drafted",
    summary: "大学期间在部队医院遇到的军装朋友，已经有线索，仍需要补充相遇和离别。",
    followups: ["你们是在什么情况下认识的？", "后来还保持联系吗？"],
    source: "补充材料 · 大学时期 · 待继续采访",
  },
  "graduation-choice": {
    title: "毕业分配：优先选择天津院",
    stageId: "university",
    status: "collecting",
    summary: "毕业分配时优先选择天津水泥工业设计研究院，是大学阶段通向职业生涯的重要决定。",
    followups: ["当时为什么优先选择天津院？", "离开学校时最舍不得什么？"],
    source: "补充材料 · 大学时期 · 待继续采访",
  },
  "study-character": {
    title: "大学学习态度与做人",
    stageId: "university",
    status: "ready",
    summary: "大学期间始终把学习放在第一位，课余去图书馆读书、复习课本和完成作业，成绩在班级靠前。做人方面受父亲影响，诚实、实在、乐于助人，说话真诚直爽，有一说一，不善于吹嘘炫耀。",
    prompt: "这次我们只聊大学期间的学习和做人。大学比高中轻松一些以后，你把时间主要放在哪里？",
    followups: ["大学里哪一门课或哪一次作业最能代表你的学习态度？", "父亲具体做过什么，让你形成了这种做人方式？", "这种直爽在工作中有没有帮到你或带来过困难？"],
    source: "2026-04-10 微信原话",
    completeness: 3,
    confirmed: true,
    quotes: [
      "大学期间呢，还是始终把学习放在第一位。课余时间呢，有时同学结伴儿，有时自己去图书馆读书，复习课本的资料。",
      "我这个人呢，受我父亲的影响，比较诚实，乐于助人。没有什么坏心眼儿，就是比较实在。",
      "说话真诚直爽，有一说一，不善于吹嘘炫耀。",
    ],
    claims: [
      "大学期间始终把学习放在第一位。",
      "会去图书馆读书、复习课本资料，按时完成作业。",
      "成绩在班级靠前。",
      "受父亲影响，比较诚实、实在、乐于助人。",
      "说话真诚直爽，有一说一，不善于吹嘘炫耀。",
    ],
  },
  "handan-practice": {
    title: "邯郸半年实习",
    stageId: "career",
    status: "collecting",
    summary: "1987 年毕业后在邯郸实习半年，随后回院开始真正的设计工作。",
    followups: ["邯郸实习最先接触到什么？", "回院报到那天是什么心情？"],
    source: "补充材料 · 职业生涯",
  },
  "design-basic": {
    title: "苦练设计基本功",
    stageId: "career",
    status: "collecting",
    summary: "1987 年邯郸实习回院后，12 名水泥工艺专业同事集中手工绘图半年；1988 年成为助理工程师，第一次独立完成石家庄生料均化库，1993 年晋升工程师。",
    prompt: "1987 年从邯郸实习回院后，第一次坐到绘图板前，你最先感到的是什么？",
    followups: ["第一张图最难的部分是什么？", "石家庄生料均化库是哪一次项目？", "后来驻厂调试近十年，哪几个项目最值得单独讲？"],
    source: "补充材料 · 职业生涯 · 待确认",
    completeness: 2,
    confirmed: false,
    quotes: [
      "当时没有计算机辅助设计，所有图纸都靠图板、丁字尺手工绘制。",
      "做设计不能急，得一个细节一个细节慢慢磨、一个环节一个环节踏实学。",
      "夏天天热，一出汗手上的汗就滴到图纸上；贴在图板上前倾着身子，腰也常常酸疼。但那时候年轻，没觉得有多苦。",
    ],
    claims: [
      "1987 年从邯郸实习回院后，12 名同事集中手工绘图半年。",
      "第一阶段没有计算机辅助设计，图纸依靠图板和丁字尺完成。",
      "1988 年成为助理工程师，第一次独立完成石家庄生料均化库。",
      "1993 年晋升为工程师。",
      "驻厂调试、项目清单和具体年份仍需继续核对。",
    ],
  },
  "commissioning": {
    title: "驻厂调试近十年",
    stageId: "career",
    status: "collecting",
    summary: "围绕工程项目驻厂调试近十年，具体项目、规模、年份和角色可以拆成下一组采访。",
    followups: ["哪六个调试项目最值得留下？", "第一次驻厂时遇到什么困难？"],
    source: "补充材料 · 职业生涯 · 待继续采访",
  },
  "standards-research": {
    title: "国家规范与科研标准",
    stageId: "career",
    status: "collecting",
    summary: "参与国家规范、科研和标准相关工作，是职业生涯里另一条值得独立整理的主线。",
    followups: ["具体参与过哪些规范或标准？", "这类工作和工程现场有什么不同？"],
    source: "补充材料 · 职业生涯 · 待确认",
  },
  "mentor-young-designers": {
    title: "给年轻设计师审图与培训",
    stageId: "career",
    status: "collecting",
    summary: "从做设计到审图和培训年轻设计师，经验传承构成职业后期的重要内容。",
    followups: ["你最常提醒年轻设计师什么？", "有没有一位年轻同事让你印象很深？"],
    source: "补充材料 · 职业生涯 · 待继续采访",
  },
  "family-life": {
    title: "一家人的日常",
    stageId: "retirement",
    status: "collecting",
    summary: "关于配偶罗志兰、儿子郭伟航和孙辈秋果、橙橙的家庭生活，等待一次专门访谈。",
    followups: ["你想先讲哪一位家人？", "一家人最常一起做什么？"],
    source: "补充材料 · 家庭、退休与人生寄语 · 待展开",
  },
  retirement: {
    title: "退休后的生活",
    stageId: "retirement",
    status: "collecting",
    summary: "退休以后生活节奏和关注点的变化，尚未进入正式访谈。",
    followups: ["退休后的第一件大事是什么？", "现在每天最享受的时刻是什么？"],
    source: "补充材料 · 家庭、退休与人生寄语 · 待展开",
  },
  "message-to-young": {
    title: "留给晚辈的人生寄语",
    stageId: "retirement",
    status: "collecting",
    summary: "想留给秋果、橙橙和晚辈的人生话，适合作为全书最后一组访谈。",
    followups: ["如果只留下一句话，你会怎么说？", "这句话来自你人生中的哪段经历？"],
    source: "补充材料 · 家庭、退休与人生寄语 · 待展开",
  },
};

const discoveryStories = [
  { id: "first-departure", action: "generate", status: "内容丰富", source: "第一次离家、约 200 公里、坐车 7 小时" },
  { id: "dorm-five", action: "generate", status: "内容丰富", source: "五个地区的同学、四年寝室生活" },
  { id: "lantern-festival", action: "generate", status: "内容丰富", source: "河边、灯会和街道的人流" },
  { id: "hospital-friendship", action: "continue", status: "较完整", source: "部队医院里的军装朋友" },
  { id: "graduation-choice", action: "continue", status: "仍可补充心路", source: "毕业分配时优先选择天津院" },
];

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function button(label, action, className = "secondary-button", attributes = "") {
  return `<button type="button" class="${className}" data-action="${action}" ${attributes}>${label}</button>`;
}

function topbar(title, subtitle, backAction = "home", right = "") {
  return `
    <header class="mobile-topbar">
      <button type="button" class="back-button" data-action="${backAction}" aria-label="返回"><span class="back-glyph">‹</span></button>
      <div>
        <h2>${title}</h2>
        ${subtitle ? `<p>${subtitle}</p>` : ""}
      </div>
      <div class="topbar-right">${right || `<span class="topbar-spacer" aria-hidden="true"></span>`}</div>
    </header>
  `;
}

function bottomNav(active = "life") {
  return `
    <nav class="bottom-nav" aria-label="主导航">
      <button type="button" class="${active === "life" ? "active" : ""}" data-action="home"><span>⌂</span>我的人生</button>
      <button type="button" class="${active === "sessions" ? "active" : ""}" data-action="result"><span>◷</span>访谈记录</button>
      <button type="button" class="${active === "me" ? "active" : ""}" data-action="home"><span>○</span>我的</button>
    </nav>
  `;
}

function getStage(stageId = demoState.activeStageId) {
  return stageCatalog.find((stage) => stage.id === stageId) || stageCatalog[3];
}

function getStory(storyId = demoState.activeStoryId) {
  return storyCatalog[storyId] || {
    title: "待展开的故事",
    stageId: demoState.activeStageId,
    status: "collecting",
    summary: "这个故事已经留下了一个入口，等待下一次连续语音访谈来补全。",
    followups: ["这件事发生在什么时候？", "你最想留下哪个画面？"],
    source: "补充材料 · 待展开",
    completeness: 1,
    confirmed: false,
  };
}

function getStoryStatus(story) {
  const status = story.status || "collecting";
  const completeness = story.completeness || (status === "final" || status === "ready" ? 3 : status === "drafted" ? 2 : 1);
  return {
    status,
    completeness,
    confirmed: story.confirmed ?? (status === "ready" || status === "final"),
    label: status === "final" ? "定稿" : status === "ready" ? "已较完整" : status === "drafted" ? "已有初稿" : "收集中",
  };
}

function onboardingCompletedCount() {
  return Math.min(demoState.onboardingStep, coreInterviewSections.length);
}

function onboardingChecklist(extraClass = "") {
  const completedCount = onboardingCompletedCount();
  return `
    <section class="onboarding-checklist ${extraClass}">
      <div class="checklist-head">
        <div><strong>首次访谈核心信息</strong><span>这些部分会自动更新</span></div>
        <span>${completedCount}/${coreInterviewSections.length} 已聊到</span>
      </div>
      <div class="checklist-rows">
        ${coreInterviewSections
          .map((section, index) => {
            const checked = index < completedCount;
            const current = index === completedCount && completedCount < coreInterviewSections.length;
            return `
              <div class="check-row ${checked ? "checked" : ""} ${current ? "current" : ""}">
                <span class="check-box" aria-hidden="true">${checked ? "✓" : ""}</span>
                <span class="check-content"><strong>${section.label}</strong><small>${checked ? "已聊到" : current ? "正在聊这一部分" : section.detail}</small></span>
                <span class="check-status">${checked ? "已完成" : current ? "当前" : "待了解"}</span>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
  `;
}

function renderOnboarding() {
  const completedCount = onboardingCompletedCount();
  const isComplete = completedCount === coreInterviewSections.length;
  const currentSection = coreInterviewSections[Math.min(completedCount, coreInterviewSections.length - 1)];
  const hasStarted = demoState.onboardingStarted;

  if (isComplete) {
    return `
      <div class="mobile-screen onboarding-screen onboarding-complete">
        <header class="mobile-topbar">
          <div>
            <p class="eyebrow">首次人生访谈</p>
            <h2>核心信息已齐</h2>
          </div>
          <span class="status-tag ready">${completedCount}/${coreInterviewSections.length} 已完成</span>
        </header>
        <div class="scroll-content">
          <section class="first-call-hero">
            <span class="result-mark">✓</span>
            <p class="eyebrow">可以进入下一步</p>
            <h1 class="screen-title">你的第一张人生地图，可以开始整理了。</h1>
            <p class="screen-intro">核心问题已经聊完整。接下来会把刚才谈到的人生阶段和阶段里的故事展示在首页。</p>
          </section>
          ${onboardingChecklist()}
          <div class="onboarding-actions">
            ${button("结束首次访谈，进入人生阶段", "finish-onboarding", "primary-button")}
            <p class="small-note">只有核心信息全部聊完，才会出现这个入口。</p>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="mobile-screen onboarding-screen">
      <header class="mobile-topbar">
        <div>
          <p class="eyebrow">${hasStarted ? "继续首次访谈" : "第一次使用"}</p>
          <h2>${hasStarted ? "继续认识你" : "第一次通话"}</h2>
        </div>
        <span class="status-tag accent">${completedCount}/${coreInterviewSections.length} 已完成</span>
      </header>
      <div class="scroll-content">
        <section class="first-call-hero">
          <p class="eyebrow">首次建档 · 必须完成</p>
          <h1 class="screen-title">先用一场通话，建立你的人生地图。</h1>
          <p class="screen-intro">这不是一问一答的聊天窗口，而是一场连续语音访谈。你可以自然讲几分钟，AI 会边听边判断哪些核心部分已经聊到。</p>
        </section>

        <div class="call-ready-card">
          <span class="light-call-avatar">AI</span>
          <div class="call-ready-copy"><strong>人生采访局</strong><span>${hasStarted ? "通话中断后可从未完成部分继续" : "连续语音访谈 · 从一个问题开始"}</span></div>
          <span class="status-tag accent">电话模式</span>
        </div>

        ${onboardingChecklist()}

        <div class="setup-block onboarding-question-block">
          <p class="setup-label">${hasStarted ? "下一段会聊" : "通话开始会问"}</p>
          <div class="question-card"><p>${currentSection.prompt}</p></div>
        </div>

        <div class="onboarding-actions">
          ${button(hasStarted ? "继续首次通话" : "开始首次通话", "start-onboarding", "primary-button")}
          <p class="small-note">核心信息未全部聊完前，不能进入人生阶段页面；如果现在挂断，下次打开仍会从未完成项继续。</p>
        </div>
      </div>
    </div>
  `;
}

function renderOnboardingCall() {
  const completedCount = onboardingCompletedCount();
  const isComplete = completedCount === coreInterviewSections.length;
  const currentSection = coreInterviewSections[Math.min(completedCount, coreInterviewSections.length - 1)];
  const callPrompt = isComplete ? "核心信息已经聊完整了。要结束这次通话，进入人生阶段地图吗？" : currentSection.prompt;
  const callStatus = demoState.callPaused ? "通话已暂停" : "正在通话 · " + (isComplete ? "核心信息已齐" : "AI 正在听你讲");

  return `
    <div class="call-screen onboarding-call-screen">
      <div class="call-topbar">
        <div><p>首次人生访谈</p><strong>正在为你建立人生地图</strong></div>
        <button type="button" class="call-close" data-action="end-onboarding-call" aria-label="挂断">×</button>
      </div>
      <div class="call-center">
        <div class="call-avatar">AI</div>
        <h1>人生采访局</h1>
        <span class="call-status">${callStatus}</span>
        <div class="call-timer">08:32</div>
        <div class="call-transcript"><small>AI 当前问题</small><p>${callPrompt}</p></div>
        ${onboardingChecklist("call-checklist")}
        <div class="onboarding-call-action">
          ${button(isComplete ? "结束通话，进入人生阶段" : "继续聊这一部分", isComplete ? "finish-onboarding" : "advance-onboarding", "primary-button")}
          <p class="call-action-note">${isComplete ? "所有核心项已自动打勾，可以进入下一界面。" : "每次自然讲完一段，系统会自动更新上面的勾选状态。"}</p>
        </div>
      </div>
      <div class="call-controls onboarding-call-controls">
        <button type="button" class="call-control" data-action="onboarding-note"><span class="call-control-icon">☰</span><span>看清单</span></button>
        <button type="button" class="call-control" data-action="pause-call"><span class="call-control-icon">${demoState.callPaused ? "▶" : "Ⅱ"}</span><span>${demoState.callPaused ? "继续" : "暂停"}</span></button>
        <button type="button" class="hangup-button" data-action="end-onboarding-call" aria-label="挂断">✆</button>
      </div>
    </div>
  `;
}

function stageCard(stage) {
  const storyRows = stage.stories
    .map((storyId) => {
      const story = getStory(storyId);
      return storyRow(story.title, story.status, storyId);
    })
    .join("");

  return `
    <article class="timeline-item">
      <div class="stage-card ${stage.featured ? "featured" : ""}">
        <div class="stage-card-head">
          <button type="button" class="stage-card-link" data-action="view-stage" data-stage-id="${stage.id}">
            <h3>${stage.title}</h3>
            <span>${stage.years}</span>
          </button>
          <div class="stage-card-actions">
            ${button("☎ 增加/修改", "start-stage-call", "call-button", `data-stage-id="${stage.id}"`)}
            ${button("删除", "delete-stage", "danger-button", `data-stage-id="${stage.id}"`)}
          </div>
        </div>
        <div class="stage-meta"><span>${stage.stories.length} 个故事</span><span>${stage.featured ? "最近有更新" : stage.years === "待展开" ? "等待建立" : "已建立骨架"}</span></div>
        <p class="stage-summary">${stage.summary}</p>
        <div class="story-list">${storyRows}</div>
      </div>
    </article>
  `;
}

function storyRow(title, status = "collecting", storyId = demoState.activeStoryId) {
  const story = storyCatalog[storyId] || { status };
  const storyState = getStoryStatus(story);
  return `
    <button type="button" class="story-row" data-action="view-story" data-story-id="${storyId}">
      <span class="story-row-title"><i class="story-mark"></i><strong>${title}</strong></span>
      <span class="story-arrow">›</span>
      <span class="status-tag ${storyState.status === "final" ? "final" : storyState.status === "ready" ? "ready" : storyState.status === "drafted" ? "drafted" : ""}">${storyState.label}</span>
    </button>
  `;
}

function renderHome() {
  const storyCount = stageCatalog.reduce((total, stage) => total + stage.stories.length, 0);
  return `
    <div class="mobile-screen home-screen">
      <header class="mobile-topbar">
        <div>
          <p class="eyebrow">人生采访局</p>
          <h2>我的人生</h2>
        </div>
        <div class="topbar-right"><span class="profile-disc">郭</span></div>
      </header>
      <div class="scroll-content">
        <section class="home-greeting">
          <div>
            <p class="eyebrow">欢迎回来，${profile.name}老师</p>
            <h1 class="screen-title">继续把人生讲下去。</h1>
            <p class="screen-intro">每一次通话都会留下原始记录，也会慢慢整理出新的阶段和故事。</p>
          </div>
        </section>

        <section class="profile-card">
          <div class="profile-card-head">
            <span class="profile-disc profile-disc-large">郭</span>
            <div>
              <p class="eyebrow">我的人生档案</p>
              <h3>${profile.name}</h3>
              <span>${profile.occupation} · ${profile.origin}</span>
            </div>
          </div>
          <div class="profile-facts">
            <div><span>出生</span><strong>${profile.birth}</strong></div>
            <div><span>现居</span><strong>${profile.location}</strong></div>
            <div><span>家庭</span><strong>${profile.family}</strong></div>
          </div>
          <p class="profile-note">${profile.work}。档案会随着每次访谈继续补充和修正。</p>
        </section>

        <div class="home-summary">
          <div class="summary-cell"><strong>${stageCatalog.length}</strong><span>人生阶段</span></div>
          <div class="summary-cell"><strong>${storyCount}</strong><span>故事线索</span></div>
          <div class="summary-cell"><strong>5</strong><span>待确认</span></div>
        </div>

        <section class="pending-card">
          <div class="pending-card-head"><div><p class="eyebrow">资料整理提醒</p><h3>有一些细节等待你确认</h3></div><span class="status-tag accent">待确认</span></div>
          <p>AI 只会把有原始记录支持、并经你确认的内容写入正式档案。母亲姓名、部分年代和工程项目清单仍保留为线索。</p>
          ${button("查看待确认线索", "pending-profile", "text-button")}
        </section>

        <section class="overview-call-entry">
          <div><p class="eyebrow">人生阶段总览</p><h3>想增加或修改一个人生阶段？</h3><p>直接进入连续语音通话，边聊边调整时间流。</p></div>
          ${button("☎ 进入通话", "start-overview-call", "call-button")}
        </section>

        <div class="section-heading"><h3>人生时间流</h3><span>从早年到现在</span></div>
        <div class="timeline">
          ${stageCatalog.filter((stage) => !demoState.deletedStageIds.includes(stage.id)).map((stage) => stageCard(stage)).join("")}
        </div>
        <p class="small-note">阶段是可以继续聊的入口；故事卡片进入更具体的 Story State。</p>
      </div>
      ${bottomNav("life")}
    </div>
  `;
}

function renderStage() {
  const stage = getStage();
  const storyRows = stage.stories
    .map((storyId) => {
      const story = getStory(storyId);
      return storyRow(story.title, story.status, storyId);
    })
    .join("");

  return `
    <div class="mobile-screen stage-screen">
      ${topbar(stage.title, stage.years + " · " + stage.stories.length + " 个故事", "home")}
      <div class="scroll-content">
        <section class="detail-hero">
          <p class="eyebrow">人生阶段</p>
          <h1 class="screen-title">${stage.title}</h1>
          <p class="screen-intro">${stage.summary}</p>
        </section>

        <div class="detail-card">
          <h3>当前阶段概要</h3>
          <p>这个阶段已经形成一组可以继续追问的故事入口。阶段通话会允许自然发散，结束后再由 AI 把新线索拆成故事卡片。</p>
          <div class="stage-call-row">
            <p><strong>想从这个阶段继续回忆？</strong><small>先聊整体，再决定哪些故事值得留下</small></p>
            ${button("☎ 增加/修改这个阶段", "start-stage-call", "call-button", `data-stage-id="${stage.id}"`)}
          </div>
        </div>

        <div class="section-heading"><h3>这个阶段的故事</h3><span>${stage.stories.length} 个</span></div>
        <div class="story-list">${storyRows}</div>
        <div class="empty-space"></div>
        <div class="detail-actions">
          ${button("＋ 添加一个故事", "new-story", "primary-button")}
          ${button("删除这个人生阶段", "delete-stage", "danger-button")}
        </div>
      </div>
    </div>
  `;
}

function renderStory() {
  const story = getStory();
  const storyState = getStoryStatus(story);
  const stage = getStage(story.stageId);
  const meter = [0, 1, 2].map((index) => `<span class="${index < storyState.completeness ? "filled" : ""}"></span>`).join("");
  const organizeButton = storyState.completeness >= 3
    ? button(storyState.status === "final" ? "查看定稿" : "整理故事", "draft-story", "compact-button")
    : button("完整后可整理", "draft-story", "disabled-button", "disabled");
  const quoteBlock = story.quotes
    ? `
      <div class="evidence-block">
        <div class="evidence-heading"><strong>已保留的原话</strong><span>${story.quotes.length} 条</span></div>
        <div class="quote-list">${story.quotes.map((quote) => `<blockquote>“${quote}”</blockquote>`).join("")}</div>
        <p class="evidence-note">原话会一直保留；AI 整理出的正式表述仍以你的确认状态为准。</p>
      </div>
    `
    : "";

  return `
    <div class="mobile-screen story-screen">
      ${topbar("故事详情", stage.title + " · Story", "stage")}
      <div class="scroll-content">
        <section class="story-detail-head">
          <div>
            <p class="eyebrow">具体故事</p>
            <h1>${story.title}</h1>
          </div>
          <span class="status-tag ${storyState.status === "final" ? "final" : storyState.status === "ready" ? "ready" : storyState.status === "drafted" ? "drafted" : ""}">${storyState.label}</span>
        </section>

        <div class="state-block">
          <div class="state-block-heading"><strong>当前故事的完整度</strong><div class="state-heading-actions"><span class="status-tag ${storyState.status === "final" ? "final" : storyState.status === "ready" ? "ready" : "accent"}">${storyState.label}</span>${organizeButton}</div></div>
          <div class="qualitative-meter">${meter}</div>
          <div class="state-caption"><span>${storyState.status === "final" ? "已经定稿" : storyState.completeness >= 3 ? "已经比较完整" : "正在形成故事骨架"}</span><span>${storyState.status === "final" ? "正式版本" : storyState.completeness >= 3 ? "可以整理成文章" : "还有关键片段"}</span></div>
          <div class="state-summary">
            <h3>当前已经讲到了什么</h3>
            <p>${story.summary}</p>
          </div>
        </div>

        ${quoteBlock}

        <div class="followup-box">
          <h3>下一步 AI 还会关心什么</h3>
          <ul class="followup-list">
            ${story.followups.map((item) => `<li>${item}</li>`).join("")}
          </ul>
        </div>

        <div class="story-actions">
          ${button("☎ 增加/修改这个故事", "start-story-call", "primary-button")}
          ${button("删除这个故事", "delete-story", "danger-button")}
        </div>

        <div class="source-row"><span>原始记录 · ${story.source}</span><button type="button" class="text-button" data-action="show-source">查看原话</button></div>
      </div>
    </div>
  `;
}

function renderStoryEdit() {
  const story = getStory();
  const stage = getStage(story.stageId);
  const storyState = getStoryStatus(story);
  const isFinal = storyState.status === "final";
  const voiceLabel = demoState.editVoiceActive ? "结束语音意见" : "🎙 提出改稿意见";
  const voiceHint = demoState.editVoiceActive ? "正在听取你的修改意见……说完后再按一次保存。" : "按住这个入口的感觉来表达，你可以直接说哪里要改、哪里要补。";

  return `
    <div class="mobile-screen story-edit-screen">
      ${topbar("整理故事", stage.title + " · " + (isFinal ? "定稿" : "草稿"), "story")}
      <div class="scroll-content">
        <section class="edit-hero">
          <p class="eyebrow">故事整理</p>
          <h1 class="screen-title">${story.title}</h1>
          <div class="edit-status-row">
            <span class="status-tag ${isFinal ? "final" : "accent"}">${isFinal ? "定稿" : "整理中"}</span>
            <span>原始记录会一直保留</span>
          </div>
          <p class="screen-intro">这里是独立的故事整理界面。AI 先给出一版整理稿，你可以用语音提出修改意见，再决定是否定稿。</p>
        </section>

        <section class="story-draft-preview">
          <div class="draft-preview-head"><div><p class="eyebrow">当前整理稿</p><h3>故事正文预览</h3></div><span class="status-tag ${isFinal ? "final" : "drafted"}">${isFinal ? "定稿" : "草稿"}</span></div>
          <p>${story.summary}</p>
          <div class="draft-source">来源：${story.source}</div>
        </section>

        <section class="voice-edit-card">
          <p class="setup-label">用声音提出修改意见</p>
          <p>不需要打字，直接告诉 AI “这里不准确”“再补上那段经历”或“语气更像我一点”。</p>
          <button type="button" class="voice-edit-button ${demoState.editVoiceActive ? "active" : ""}" data-action="voice-edit-note"><span class="voice-edit-icon">🎙</span><strong>${voiceLabel}</strong></button>
          <span class="voice-edit-hint">${voiceHint}</span>
        </section>

        <div class="edit-actions">
          ${isFinal ? `<div class="final-notice"><span class="result-mark">✓</span><div><strong>这个故事已经定稿</strong><p>如果还要修改，可以继续通话或重新提出语音意见。</p></div></div>` : button("定稿并保存", "finalize-story", "primary-button")}
          ${button("☎ 继续采访补充", "start-story-call", "secondary-button")}
          ${button("查看原话", "show-source", "text-button")}
        </div>
      </div>
    </div>
  `;
}

function renderCallChecklist() {
  const isStage = demoState.activeScope === "stage";
  const isOverview = demoState.activeScope === "overview";
  let items = [];

  if (isOverview) {
    items = stageCatalog
      .filter((stage) => !demoState.deletedStageIds.includes(stage.id))
      .map((stage) => ({ label: stage.title, detail: stage.years, checked: stage.years !== "待展开" }));
  } else if (isStage) {
    const stage = getStage();
    items = stage.stories.map((storyId) => {
      const story = getStory(storyId);
      const state = getStoryStatus(story);
      return { label: story.title, detail: state.label, checked: state.completeness >= 3 };
    });
  } else {
    const story = getStory();
    const state = getStoryStatus(story);
    items = story.followups.map((item, index) => ({
      label: item,
      detail: state.status === "final" ? "已处理" : index === 0 ? "下一步重点" : "待聊",
      checked: state.status === "final",
    }));
  }

  return `
    <section class="call-checklist-panel">
      <div class="call-checklist-head"><div><strong>本次通话清单</strong><span>${isOverview ? "可增加/修改人生阶段" : isStage ? "阶段里的故事线索" : "当前故事的追问方向"}</span></div><span>${items.filter((item) => item.checked).length}/${items.length}</span></div>
      <div class="call-checklist-items">
        ${items.map((item) => `<div class="call-check-row ${item.checked ? "checked" : ""}"><span>${item.checked ? "✓" : ""}</span><div><strong>${item.label}</strong><small>${item.detail}</small></div></div>`).join("")}
      </div>
    </section>
  `;
}

function renderCallSetup() {
  const isStage = demoState.activeScope === "stage";
  const isOverview = demoState.activeScope === "overview";
  const stage = getStage();
  const story = getStory();
  const sceneTitle = isOverview ? "人生阶段总览" : isStage ? stage.title : story.title;
  const sceneDescription = isOverview ? "可以增加、修改或重新命名人生阶段" : isStage ? "允许在这个阶段内自然发散，结束后再发现故事" : "只围绕这个故事继续补充，不切换到其他故事";
  const callPrompt = isOverview ? "如果回看这张人生时间流，有没有一个阶段需要增加或修改？" : isStage ? stage.prompt : story.prompt || story.followups[0];
  return `
    <div class="mobile-screen setup-screen">
      <header class="mobile-topbar">
        <button type="button" class="back-button" data-action="back-from-setup" aria-label="返回"><span class="back-glyph">‹</span></button>
        <div><h2>开始一场通话</h2><p>先确认这一次要聊什么</p></div>
        <button type="button" class="topbar-action" data-action="home" aria-label="关闭">×</button>
      </header>
      <div class="scroll-content">
        <section class="setup-header">
          <p class="eyebrow">${isOverview ? "人生阶段整理" : isStage ? "人生阶段访谈" : "故事访谈"}</p>
          <h1>准备好和 AI 聊一会儿了吗？</h1>
          <p>这会是一段连续的语音通话。你可以自然讲几分钟，不需要一问一答地提交语音消息。</p>
        </section>

        <div class="setup-block">
          <p class="setup-label">本次场景</p>
          <div class="scope-line">
            <div><strong>${sceneTitle}</strong><p>${sceneDescription}</p></div>
            <span class="mode-tag accent">${isOverview ? "LifeMap" : isStage ? "LifeStage" : "Story"}</span>
          </div>
        </div>

        <div class="setup-block">
          <p class="setup-label">这次 AI 会重点了解</p>
          <div class="question-card"><p>${callPrompt}</p></div>
        </div>

        <div class="setup-block">
          <p class="setup-label">设备状态</p>
          <div class="mic-ready"><span class="mic-icon">♩</span><span>麦克风已准备好 · 通话结束后会保存音频与文字</span></div>
        </div>

        <div class="setup-actions">
          ${button("开始通话", "start-call", "primary-button")}
        </div>
      </div>
    </div>
  `;
}

function renderCall() {
  const isStage = demoState.activeScope === "stage";
  const isOverview = demoState.activeScope === "overview";
  const stage = getStage();
  const story = getStory();
  const callTitle = isOverview ? "人生阶段总览" : isStage ? stage.title : story.title;
  const callPrompt = isOverview ? "如果回看这张人生时间流，有没有一个阶段需要增加或修改？" : isStage ? stage.prompt : story.prompt || story.followups[0];
  return `
    <div class="call-screen">
      <div class="call-topbar">
        <div><p>连续语音访谈</p><strong>${callTitle}</strong></div>
        <button type="button" class="call-close" data-action="end-call" aria-label="结束通话">×</button>
      </div>
      <div class="call-center ${demoState.callChecklistOpen ? "call-center-with-checklist" : ""}">
        <div class="call-avatar">AI</div>
        <h1>人生采访局</h1>
        <span class="call-status">${demoState.callPaused ? "通话已暂停" : "正在通话 · AI 正在听你讲"}</span>
        <div class="call-timer">12:48</div>
        <div class="call-transcript"><small>AI 刚刚问</small><p>${callPrompt}</p></div>
        ${demoState.callChecklistOpen ? renderCallChecklist() : ""}
      </div>
      <div class="call-controls">
        <button type="button" class="call-control" data-action="toggle-call-checklist"><span class="call-control-icon">☰</span><span>${demoState.callChecklistOpen ? "收起清单" : "看清单"}</span></button>
        <button type="button" class="call-control" data-action="pause-call"><span class="call-control-icon">${demoState.callPaused ? "▶" : "Ⅱ"}</span><span>${demoState.callPaused ? "继续" : "暂停"}</span></button>
        <button type="button" class="hangup-button" data-action="end-call" aria-label="挂断">✆</button>
        <button type="button" class="call-control" data-action="call-speaker"><span class="call-control-icon">◉</span><span>扬声器</span></button>
      </div>
    </div>
  `;
}

function renderStoryResult() {
  const story = getStory();
  const stage = getStage(story.stageId);
  const storyState = getStoryStatus(story);
  const claims = (story.claims || [story.summary]).map((claim, index) => {
    const pending = demoState.activeStoryId === "design-basic" && index === story.claims.length - 1;
    return `<div class="result-item"><span class="result-item-mark">${pending ? "?" : "✓"}</span><p>${claim}</p></div>`;
  }).join("");

  return `
    <div class="mobile-screen result-screen">
      ${topbar("访谈结果", "刚刚结束 · 已保存", "story")}
      <div class="scroll-content">
        <section class="result-header">
          <span class="result-mark">✓</span>
          <h1>这次通话已经保存</h1>
          <p>原始音频和文字会一直保留。下面是 AI 根据“${story.title}”生成的本次整理结果。需要修改时，请回到故事详情或继续通话。</p>
        </section>

        <div class="result-meta">
          <div class="result-meta-cell"><span>访谈场景</span><strong>${stage.title}</strong></div>
          <div class="result-meta-cell"><span>原始材料</span><strong>音频 + 文字</strong></div>
        </div>

        <section class="result-section">
          <h3>Story State 已更新</h3>
          <div class="result-update"><p>“${story.title}”已经保留为独立故事。当前完整度为“${storyState.completeness >= 3 ? "已较完整" : "收集中"}”，还可以继续追问。</p></div>
        </section>

        <section class="result-section">
          <h3>本次生成的整理结果</h3>
          ${claims}
        </section>

        <section class="result-section result-source-section">
          <h3>来源</h3>
          <div class="source-trace"><span>原始材料</span><strong>${story.source}</strong></div>
        </section>

        <div class="result-actions">
          ${button("完成", "finish-result", "primary-button")}
        </div>
      </div>
    </div>
  `;
}

function renderDiscoveryResult() {
  const stage = getStage();
  const resultStories = stage.id === "university"
    ? discoveryStories
    : stage.stories.slice(0, 5).map((storyId) => {
      const story = getStory(storyId);
      const storyState = getStoryStatus(story);
      return { id: storyId, status: storyState.label, source: story.summary };
    });
  const cards = resultStories.map((item) => {
    const story = getStory(item.id);
    const statusClass = item.status === "内容丰富" || item.status === "较完整" || item.status === "已较完整" ? "ready" : "accent";
    return `
      <article class="discovery-card">
        <div class="discovery-card-head">
          <div><p class="eyebrow">候选故事</p><h3>${story.title}</h3></div>
          <span class="status-tag ${statusClass}">${item.status}</span>
        </div>
        <p>${item.source}</p>
      </article>
    `;
  }).join("");

  return `
    <div class="mobile-screen result-screen">
      ${topbar("本次访谈结果", stage.title + " · 已保存", "stage")}
      <div class="scroll-content">
        <section class="result-header">
          <span class="result-mark">✦</span>
          <h1>发现了几条故事线索</h1>
          <p>这次阶段访谈的原始音频和文字已经保存。下面是 AI 根据谈话内容提出的候选故事，不会自动成为正式记录。</p>
        </section>

        <div class="result-meta">
          <div class="result-meta-cell"><span>访谈场景</span><strong>${stage.title}</strong></div>
          <div class="result-meta-cell"><span>本页操作</span><strong>查看结果</strong></div>
        </div>

        <section class="result-section">
          <h3>建议拆成这些故事</h3>
          <div class="discovery-list">${cards}</div>
        </section>

        <div class="result-note">这些建议来自本次 Session 的原始记录。本页只展示生成结果；如果想继续、修改或删除，请回到对应的人生阶段或故事详情。</div>
        <div class="result-actions">${button("完成", "finish-result", "primary-button")}</div>
      </div>
    </div>
  `;
}

function renderOverviewResult() {
  return `
    <div class="mobile-screen result-screen">
      ${topbar("访谈结果", "人生阶段总览 · 已保存", "home")}
      <div class="scroll-content">
        <section class="result-header">
          <span class="result-mark">✓</span>
          <h1>阶段总览已生成</h1>
          <p>原始音频和文字已经保存。下面只展示本次对人生时间流的整理结果；如果要修改，请回到首页或进入对应阶段继续通话。</p>
        </section>
        <section class="result-section">
          <h3>本次生成的整理结果</h3>
          <div class="result-update"><p>目前的时间流包含“故土与童年、小学与初中、高中、大学时期、职业生涯、家庭、退休与人生寄语”六个阶段。最后一个阶段仍处于待展开状态。</p></div>
        </section>
        <section class="result-section">
          <div class="result-item"><span class="result-item-mark">✓</span><p>已保留现有阶段顺序与时间范围。</p></div>
          <div class="result-item"><span class="result-item-mark">✓</span><p>已标出可以继续补充的家庭、退休和人生寄语阶段。</p></div>
        </section>
        <div class="result-actions">${button("完成", "finish-result", "primary-button")}</div>
      </div>
    </div>
  `;
}

function renderResult() {
  if (demoState.activeScope === "overview") return renderOverviewResult();
  return demoState.activeScope === "stage" ? renderDiscoveryResult() : renderStoryResult();
}

function render() {
  const views = {
    onboarding: renderOnboarding,
    "onboarding-call": renderOnboardingCall,
    home: renderHome,
    stage: renderStage,
    story: renderStory,
    "story-edit": renderStoryEdit,
    "call-setup": renderCallSetup,
    call: renderCall,
    result: renderResult,
  };

  const view = views[demoState.screen] || renderOnboarding;
  app.innerHTML = view();
}

function navigate(screen) {
  demoState.screen = screen;
  render();
}

document.addEventListener("click", (event) => {
  const jump = event.target.closest("[data-jump]");
  if (jump) {
    navigate(jump.dataset.jump);
    return;
  }

  const actionElement = event.target.closest("[data-action]");
  if (!actionElement) return;

  const action = actionElement.dataset.action;
  switch (action) {
    case "start-onboarding":
      demoState.onboardingStarted = true;
      navigate("onboarding-call");
      break;
    case "advance-onboarding":
      if (demoState.onboardingStep < coreInterviewSections.length) {
        demoState.onboardingStep += 1;
      }
      render();
      break;
    case "finish-onboarding":
      if (onboardingCompletedCount() === coreInterviewSections.length) {
        navigate("home");
      }
      break;
    case "end-onboarding-call":
      navigate("onboarding");
      break;
    case "home":
      navigate("home");
      break;
    case "stage":
      navigate("stage");
      break;
    case "story":
      navigate("story");
      break;
    case "view-stage":
      if (actionElement.dataset.stageId) {
        demoState.activeStageId = actionElement.dataset.stageId;
      }
      navigate("stage");
      break;
    case "view-story":
      if (actionElement.dataset.storyId) {
        demoState.activeStoryId = actionElement.dataset.storyId;
        demoState.activeStageId = getStory(demoState.activeStoryId).stageId || demoState.activeStageId;
      }
      navigate("story");
      break;
    case "start-stage-call":
      if (actionElement.dataset.stageId) {
        demoState.activeStageId = actionElement.dataset.stageId;
      }
      demoState.activeScope = "stage";
      navigate("call-setup");
      break;
    case "start-overview-call":
      demoState.activeScope = "overview";
      navigate("call-setup");
      break;
    case "start-story-call":
      if (actionElement.dataset.storyId) {
        demoState.activeStoryId = actionElement.dataset.storyId;
      }
      demoState.activeScope = "story";
      navigate("call-setup");
      break;
    case "back-from-setup":
      navigate(demoState.activeScope === "overview" ? "home" : demoState.activeScope === "stage" ? "stage" : "story");
      break;
    case "start-call":
      demoState.callPaused = false;
      demoState.callChecklistOpen = false;
      navigate("call");
      break;
    case "end-call":
      demoState.pendingStoryResult = demoState.activeScope === "story";
      navigate("result");
      break;
    case "draft-story":
      if (getStoryStatus(getStory()).completeness >= 3) {
        demoState.editVoiceActive = false;
        navigate("story-edit");
      }
      break;
    case "new-story":
      demoState.activeScope = "stage";
      navigate("call-setup");
      break;
    case "finish-result":
      demoState.pendingStoryResult = false;
      navigate(demoState.activeScope === "overview" ? "home" : demoState.activeScope === "stage" ? "stage" : "story");
      break;
    case "voice-edit-note":
      demoState.editVoiceActive = !demoState.editVoiceActive;
      render();
      break;
    case "finalize-story": {
      const story = getStory();
      story.confirmed = true;
      story.status = "final";
      story.completeness = 3;
      demoState.editVoiceActive = false;
      navigate("story");
      break;
    }
    case "delete-stage": {
      const stageId = actionElement.dataset.stageId || demoState.activeStageId;
      const stage = getStage(stageId);
      if (window.confirm(`确定删除“${stage.title}”这个人生阶段吗？`)) {
        if (!demoState.deletedStageIds.includes(stageId)) demoState.deletedStageIds.push(stageId);
        navigate("home");
      }
      break;
    }
    case "delete-story": {
      const story = getStory();
      const stage = getStage(story.stageId);
      if (window.confirm(`确定删除“${story.title}”这个故事吗？`)) {
        stage.stories = stage.stories.filter((storyId) => storyId !== demoState.activeStoryId);
        navigate("stage");
      }
      break;
    }
    case "show-source":
      window.alert("演示占位：这里会展开当前故事的原始音频、Transcript、Session 和待确认事实。");
      break;
    case "pending-profile":
      window.alert("待确认线索：母亲姓名“杨华 / 杨花”、部分年代、泰山年份、王明晨老师的具体影响、2007 年同学聚会、部队医院朋友和六个驻厂调试项目。");
      break;
    case "generate-discovery-story":
      demoState.activeStoryId = actionElement.dataset.storyId || demoState.activeStoryId;
      demoState.activeScope = "story";
      navigate("story");
      break;
    case "continue-discovery-story":
      demoState.activeStoryId = actionElement.dataset.storyId || demoState.activeStoryId;
      demoState.activeScope = "story";
      navigate("call-setup");
      break;
    case "edit-discovery-title":
      window.alert("演示占位：这里会允许修改候选故事标题，并保留原始 AI 建议。");
      break;
    case "ignore-discovery-story":
      actionElement.closest(".discovery-card")?.remove();
      break;
    case "toggle-call-checklist":
      demoState.callChecklistOpen = !demoState.callChecklistOpen;
      render();
      break;
    case "pause-call":
      demoState.callPaused = !demoState.callPaused;
      render();
      break;
    case "onboarding-note":
      window.alert("这些勾选项会根据通话内容自动更新，不能手动勾选。");
      break;
    case "call-mute":
    case "call-speaker":
      window.alert("演示占位：这里连接真实通话控件。");
      break;
    default:
      break;
  }
});

render();
