/** Traditional Chinese (Hong Kong) UI copy. */

const COPY = {
  title: '小五英文拼字',
  subtitle: '每日 10 個字 · 填入缺少嘅字母',
  start: '開始今日挑戰',
  continue: '繼續挑戰',
  howTo: '玩法',
  howToBody:
    '每日 10 個英文生字。睇圖同中文意思，再填入缺少嘅 2 至 5 個字母。你有 8 粒❤生命，答錯會扣 1 粒；❤用晒就遊戲結束。全對先至計分！成績可以分享俾同學同屋企人。',
  today: '今日',
  progress: '進度',
  check: '檢查答案',
  next: '下一題',
  finish: '睇成績',
  correct: '好叻！答對喇 ✨',
  wrong: '差少少，正確拼法係：',
  hint: '提示：中文意思',
  exampleLabel: '例句',
  exampleZhLabel: '譯文',
  speakExample: '聽例句',
  score: '得分',
  of: '/',
  share: '分享成績圖',
  download: '下載圖片',
  copy: '複製圖片',
  review: '複習今日生字',
  home: '返主頁',
  loading: '載入中…',
  letters: '撳鍵盤填字母',
  clear: '清除',
  backspace: '刪除',
  doneTitle: '今日完成！',
  doneSub: '明日再嚟挑戰新字啦',
  attribution: '詞彙參考香港教育局小學英語課程詞表（KS1／KS2），並非獨立小五官方清單。',
  imageCredit: '圖片',
  shareView: '朋友嘅成績',
  playToday: '玩今日挑戰',
  emptySlot: '?',
  speak: '聽發音',
  speakLoading: '讀緊…',
  speakFail: '發音暫時唔得，試多次啦',
  hearts: '生命',
  gameOverTitle: '遊戲結束 💔',
  gameOverSub: '生命用晒喇！唔可以再繼續今日其餘題目。',
  gameOverScore: '答對題數',
  gameOverWords: '完成題數',
  seeGameOver: '睇遊戲結束',
  resetToday: '重設今日進度',
  resetConfirm: '確定要清除今日分數同進度，重新由第 1 題開始？（生命會回復 8 粒❤）',
  resetDone: '已重設，可以重新挑戰啦',
  replayPractice: '練習再玩（唔計入今日紀錄）',
};

export function t(key) {
  return COPY[key] ?? key;
}

export function getLang() {
  return 'zh-HK';
}

export function localeForNumbers() {
  return 'zh-HK';
}
