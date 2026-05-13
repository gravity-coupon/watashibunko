// UI theme tables (story display themes, player colors, timer presets).

export const TIMER_OPTIONS = [
  { sec: 0,   label: 'なし', name: '無制限', desc: 'のんびり' },
  { sec: 120, label: '2:00', name: '爆速', desc: '駄文上等' },
  { sec: 150, label: '2:30', name: '高速', desc: '勢いで書く' },
  { sec: 180, label: '3:00', name: 'サクサク', desc: 'もう迷わない' },
  { sec: 210, label: '3:30', name: 'ちょい速', desc: '手練れ向け' },
  { sec: 240, label: '4:00', name: '標準', desc: '迷える余裕あり' },
  { sec: 270, label: '4:30', name: 'まったり', desc: '推敲もできる' },
  { sec: 300, label: '5:00', name: '長考', desc: '完璧を目指す' },
];

export const STORY_THEMES = [
  { id: 'midnight',  name: '深夜',   bg: '#16213e', text: '#eee',    title: '#f0c040', meta: '#8899aa', border: '#2a3a5e', gradient: 'linear-gradient(145deg, #16213e, #1c2a4a)', dot: 'linear-gradient(135deg, #1c2a4a, #16213e)' },
  { id: 'ink',       name: '墨',     bg: '#1a1a1a', text: '#d4d4d4', title: '#e8c56d', meta: '#777',    border: '#333',    gradient: 'linear-gradient(145deg, #1a1a1a, #222)',    dot: 'linear-gradient(135deg, #222, #1a1a1a)' },
  { id: 'parchment', name: '羊皮紙', bg: '#f5f0e1', text: '#3a3226', title: '#8b4513', meta: '#8b7355', border: '#d4c9a8', gradient: 'linear-gradient(145deg, #f5f0e1, #ebe4d0)', dot: 'linear-gradient(135deg, #f5f0e1, #e0d6be)' },
  { id: 'sakura',    name: '桜',     bg: '#fdf2f5', text: '#4a3040', title: '#c0506a', meta: '#b08898', border: '#e8c8d4', gradient: 'linear-gradient(145deg, #fdf2f5, #f8e4ec)', dot: 'linear-gradient(135deg, #f8e4ec, #fdf2f5)' },
  { id: 'forest',    name: '森',     bg: '#1a2e1a', text: '#d0e0c8', title: '#8bc34a', meta: '#7a9a6a', border: '#2e4a2e', gradient: 'linear-gradient(145deg, #1a2e1a, #223a22)', dot: 'linear-gradient(135deg, #223a22, #1a2e1a)' },
  { id: 'ocean',     name: '海',     bg: '#0f1e33', text: '#c8dae8', title: '#5bb8f0', meta: '#6889a8', border: '#1e3a5a', gradient: 'linear-gradient(145deg, #0f1e33, #162a44)', dot: 'linear-gradient(135deg, #162a44, #0f1e33)' },
  { id: 'sunset',    name: '夕焼け', bg: '#2a1215', text: '#f0d8c8', title: '#f08050', meta: '#b07868', border: '#4a2228', gradient: 'linear-gradient(145deg, #2a1215, #3a1a1e)', dot: 'linear-gradient(135deg, #3a1a1e, #2a1215)' },
  { id: 'snow',      name: '雪',     bg: '#f0f2f5', text: '#2a3040', title: '#4a6a8a', meta: '#8898a8', border: '#d0d8e0', gradient: 'linear-gradient(145deg, #f0f2f5, #e6eaef)', dot: 'linear-gradient(135deg, #e6eaef, #f0f2f5)' },
  { id: 'shion',     name: '紫苑',   bg: '#1a1028', text: '#d8c8e8', title: '#b06adf', meta: '#8878a8', border: '#2e1e42', gradient: 'linear-gradient(145deg, #1a1028, #221438)', dot: 'linear-gradient(135deg, #221438, #1a1028)' },
  { id: 'desert',    name: '砂漠',   bg: '#f5ead0', text: '#3a2e1e', title: '#b07830', meta: '#9a8868', border: '#d8c8a0', gradient: 'linear-gradient(145deg, #f5ead0, #ece0c0)', dot: 'linear-gradient(135deg, #ece0c0, #f5ead0)' },
];

export const PLAYER_COLORS = [
  '#e94560','#4ecdc4','#f0c040','#a78bfa','#fb923c',
  '#34d399','#f472b6','#60a5fa','#fbbf24','#c084fc',
  '#f87171','#2dd4bf','#facc15','#818cf8','#fb7185',
  '#38bdf8',
];
