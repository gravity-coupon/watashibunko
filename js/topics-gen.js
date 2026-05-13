import { T } from './topics-data.js';

export function generateRandomTopic() {
  const r = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const n = (max) => Math.floor(Math.random() * max) + 2;
  const patterns = [
    // === WHO が WHAT した系 ===
    () => r(T.WHEN) + '、' + r(T.WHO) + 'が' + r(T.WHAT),
    () => r(T.WHERE) + r(T.WHO) + 'が' + r(T.WHAT),
    () => r(T.WHO) + 'と' + r(T.WHO) + 'が' + r(T.WHAT),
    () => r(T.WHERE) + r(T.WHEN) + '、' + r(T.WHO) + 'が' + r(T.WHAT),
    () => r(T.WHO) + 'が' + r(T.WHERE) + r(T.WHAT),
    () => r(T.WHO) + 'が' + n(5) + '回目の' + r(T.WHAT).replace(/した$|った$|だ$/, '') + 'をした',
    () => r(T.ADJ) + r(T.WHO) + 'が' + r(T.WHAT),
    () => r(T.WHO) + 'が' + r(T.ADJ) + r(T.NOUN) + 'で' + r(T.WHAT),
    () => r(T.ROLE) + 'の' + r(T.WHO) + 'が' + r(T.WHAT),
    () => r(T.WHO) + 'が' + r(T.EMOTION) + 'のあまり' + r(T.WHAT),
    // === ADJ + NOUN/WHO 系 ===
    () => r(T.ADJ) + r(T.NOUN),
    () => r(T.ADJ) + r(T.WHO),
    () => r(T.ADJ) + r(T.NOUN) + 'と' + r(T.ADJ) + r(T.WHO),
    () => r(T.ADJ) + r(T.ADJ) + r(T.NOUN),
    () => r(T.ADJ) + r(T.NOUN) + r(T.PHRASE),
    () => r(T.ADJ) + r(T.WHO) + 'の' + r(T.ADJ) + r(T.NOUN),
    // === の・と 接続系 ===
    () => r(T.WHO) + 'の' + r(T.NOUN),
    () => r(T.WHO) + 'と' + r(T.NOUN),
    () => r(T.NOUN) + 'と' + r(T.NOUN),
    () => r(T.WHO) + ' ' + r(T.NOUN),
    () => r(T.WHO) + 'の' + r(T.WHO),
    () => r(T.NOUN) + 'の中の' + r(T.NOUN),
    () => r(T.WHO) + 'の' + r(T.EMOTION),
    () => r(T.NOUN) + 'の' + r(T.NOUN) + 'の' + r(T.NOUN),
    () => r(T.EMOTION) + 'と' + r(T.EMOTION) + 'の間で',
    () => r(T.WHO) + 'と' + r(T.COUNTER) + r(T.NOUN),
    // === タイトルっぽい抽象系 ===
    () => r(T.NOUN) + r(T.NOUN_TAIL),
    () => r(T.NOUN) + r(T.NOUN_TAIL),
    () => r(T.WHO) + r(T.WHO_TAIL),
    () => r(T.WHO) + r(T.WHO_TAIL),
    () => r(T.EMOTION) + 'の' + r(T.NOUN),
    () => r(T.EMOTION) + 'を知った' + r(T.WHO),
    () => r(T.WHO) + 'による' + r(T.GENRE),
    () => r(T.WHERE) + '見つけた' + r(T.NOUN),
    () => r(T.WHO) + 'の' + r(T.ADJ) + '一日',
    () => r(T.WHO) + 'が残した' + r(T.NOUN),
    () => r(T.WHO) + 'への' + r(T.NOUN),
    () => r(T.WHO) + 'だけが知っている' + r(T.NOUN),
    () => r(T.WHEN) + '届いた' + r(T.NOUN),
    () => r(T.WHERE) + '眠る' + r(T.NOUN),
    () => r(T.ADJ) + r(T.NOUN) + r(T.NOUN_TAIL),
    () => r(T.ADJ) + r(T.WHO) + r(T.WHO_TAIL),
    // === vs / 対決系 ===
    () => r(T.WHO) + ' vs ' + r(T.WHO),
    () => r(T.WHO) + ' vs ' + r(T.NOUN),
    () => r(T.ADJ) + r(T.WHO) + ' vs ' + r(T.ADJ) + r(T.WHO),
    () => r(T.WHO) + ' vs ' + r(T.WHO) + '〜' + r(T.NOUN) + 'を賭けて〜',
    // === もしも系 ===
    () => 'もしも' + r(T.WHO) + 'が' + r(T.ROLE) + 'だったら',
    () => 'もしも' + r(T.NOUN) + 'がなかったら',
    () => 'もしも' + r(T.WHO) + 'が' + r(T.WHO) + 'だったら',
    () => 'もしも' + r(T.WHEN) + '、' + r(T.WHO) + 'が' + r(T.WHAT) + 'ら',
    () => 'もしも' + r(T.NOUN) + 'が' + r(T.ADJ) + 'ったら',
    () => 'もしも' + r(T.WHERE) + r(T.NOUN) + 'があったら',
    // === 場所・居場所系 ===
    () => r(T.NOUN) + 'に住む' + r(T.WHO),
    () => r(T.WHERE) + '暮らす' + r(T.WHO),
    () => r(T.NOUN) + 'の中の' + r(T.WHO),
    () => r(T.WHERE) + r(T.WHO) + 'を待ちながら',
    // === 動作系 ===
    () => r(T.VERB_ING) + r(T.WHO),
    () => r(T.VERB_ING) + r(T.NOUN),
    () => r(T.VERB_ING) + r(T.WHO) + 'と' + r(T.VERB_ING) + r(T.WHO),
    () => r(T.WHERE) + r(T.VERB_ING) + r(T.WHO),
    () => r(T.WHEN) + '、' + r(T.VERB_ING) + r(T.WHO),
    // === 数字系 ===
    () => r(T.WHO) + 'と' + n(99) + '個の' + r(T.NOUN),
    () => r(T.NOUN) + '第' + n(12) + '章',
    () => n(47) + '階のない' + r(T.NOUN),
    () => n(7) + '人の' + r(T.WHO),
    () => n(100) + '日後に' + r(T.WHAT) + r(T.WHO),
    () => r(T.COUNTER) + r(T.NOUN) + 'と' + r(T.COUNTER) + r(T.WHO),
    () => r(T.WHO) + 'の' + n(365) + '日',
    // === 短いインパクト系 ===
    () => r(T.NOUN) + '!',
    () => r(T.WHO) + '!',
    () => r(T.ADJ) + '。',
    () => 'さよなら、' + r(T.WHO),
    () => 'ようこそ、' + r(T.WHERE).replace(/で$/, 'へ'),
    () => r(T.WHO) + 'は二度' + r(T.WHAT).replace(/た$/, 'ない'),
    () => 'それは' + r(T.NOUN) + 'から始まった',
    () => '全ては' + r(T.NOUN) + 'のせいだった',
    () => 'その日、' + r(T.WHO) + 'は' + r(T.WHAT),
    () => r(T.NOUN) + 'よ、永遠に',
    () => r(T.WHO) + 'よ、' + r(T.EMOTION) + 'を込めて',
    // === ジャンル指定系 ===
    () => r(T.WHO) + 'が主人公の' + r(T.GENRE),
    () => r(T.WHERE) + '繰り広げられる' + r(T.GENRE),
    () => r(T.ADJ) + r(T.GENRE),
    () => r(T.NOUN) + 'をめぐる' + r(T.GENRE),
    () => r(T.EMOTION) + 'がテーマの' + r(T.GENRE),
    () => r(T.WHO) + 'と' + r(T.WHO) + 'の' + r(T.GENRE),
    // === 文書系 ===
    () => r(T.WHO) + r(T.PHRASE),
    () => r(T.NOUN) + r(T.PHRASE),
    () => r(T.ADJ) + r(T.NOUN) + r(T.PHRASE),
    () => r(T.WHO) + 'の' + r(T.NOUN) + r(T.PHRASE),
    // === 対比系 ===
    () => r(T.NOUN) + 'と' + r(T.NOUN) + 'の間で',
    () => r(T.WHO) + '、あるいは' + r(T.WHO),
    () => r(T.ADJ) + r(T.NOUN) + 'か、' + r(T.ADJ) + r(T.NOUN) + 'か',
    () => r(T.EMOTION) + 'か' + r(T.EMOTION) + 'か',
    // === 謎・問いかけ系 ===
    () => 'なぜ' + r(T.WHO) + 'は' + r(T.WHAT) + 'のか',
    () => r(T.WHO) + 'は本当に' + r(T.WHAT) + 'のか',
    () => r(T.NOUN) + 'はどこへ消えた？',
    () => '誰が' + r(T.NOUN) + 'を' + r(T.WHAT).replace(/した$|った$|だ$/, '') + 'たのか',
    // === 時系列系 ===
    () => r(T.WHO) + 'の' + r(T.WHEN).replace(/に$|で$/, '') + 'から' + r(T.WHEN).replace(/に$|で$/, '') + 'まで',
    () => r(T.NOUN) + 'が生まれた日から消えるまで',
    () => r(T.WHO) + 'の最初の' + r(T.NOUN) + 'と最後の' + r(T.NOUN),
    // === 手紙・語りかけ系 ===
    () => '親愛なる' + r(T.WHO) + 'へ',
    () => r(T.WHO) + 'からの手紙',
    () => r(T.WHO) + 'からの招待状',
    () => r(T.WHO) + 'による遺言',
    () => r(T.WHEN) + 'の' + r(T.WHO) + 'へ',
    // === 場所+形容系 ===
    () => r(T.ADJ) + r(T.WHERE).replace(/で$/, ''),
    () => r(T.WHERE) + r(T.ADJ) + r(T.NOUN),
    () => r(T.WHEN) + '、' + r(T.ADJ) + r(T.WHERE).replace(/で$/, ''),
  ];
  return r(patterns)();
}
