// hashtags.js — Append popular hashtags to tweets to maximize reach

const TAG_MAP = {
  // ── Generic genres ──────────────────────────────────────────────────────────
  'manga':         ['#manga', '#MangaRecommendations', '#MangaArt', '#mangalife', '#anime'],
  'manhwa':        ['#manhwa', '#manhwatiktok', '#manhwalover', '#manhwafan', '#anime'],
  'anime':         ['#anime', '#otaku', '#animerecommendations', '#animelovers', '#animefan'],
  'free':          ['#freeread', '#manga', '#manhwa', '#webtoon', '#Webtoons'],
  'relatable':     ['#anime', '#otaku', '#manga', '#manhwafan', '#animememes'],
  'meme':          ['#animememes', '#anime', '#manga', '#otaku', '#manhwafan'],
  'community':     ['#manga', '#manhwa', '#anime', '#otaku', '#MangaCommunity'],
  'recommendation':['#MangaRecommendations', '#anime', '#manga', '#manhwa', '#animerecommendations'],
  'hottake':       ['#anime', '#manga', '#manhwa', '#otaku', '#animediscussion'],
  'powerscaling':  ['#powerscaling', '#manhwa', '#anime', '#manga', '#otaku'],
  'isekai':        ['#isekai', '#manhwa', '#manga', '#anime', '#animefan'],
  'murim':         ['#murim', '#manhwa', '#cultivation', '#wuxia', '#manhwalover'],
  'wuxia':         ['#wuxia', '#manhwa', '#murim', '#cultivation', '#manga'],
  'webtoon':       ['#webtoon', '#Webtoons', '#manhwa', '#manga'],

  // ── Titles ───────────────────────────────────────────────────────────────────
  'SoloLeveling':          ['#SoloLeveling', '#SungJinwoo', '#manhwa', '#anime', '#WeakToStrong'],
  'sololveling':           ['#SoloLeveling', '#SungJinwoo', '#manhwa', '#anime'],
  'ARISE':                 ['#SoloLeveling', '#ARISE', '#SungJinwoo', '#manhwa'],
  'OP':                    ['#manhwa', '#powerscaling', '#WeakToStrong', '#anime'],
  'TowerOfGod':            ['#TowerOfGod', '#Baam', '#manhwa', '#anime', '#Webtoons'],
  'Baam':                  ['#TowerOfGod', '#manhwa', '#Baam', '#anime'],
  'Khun':                  ['#TowerOfGod', '#manhwa', '#Khun', '#anime'],
  'ORV':                   ['#ORV', '#OmniscientReader', '#manhwa', '#manhwalover'],
  'OmniscientReadersViewpoint': ['#ORV', '#OmniscientReader', '#manhwa', '#manhwafan'],
  'NanoMachine':           ['#NanoMachine', '#manhwa', '#murim', '#manhwalover'],
  'TBATE':                 ['#TBATE', '#TheBeginningAfterTheEnd', '#manhwa', '#isekai'],
  'EminenceInShadow':      ['#EminenceInShadow', '#CidKagenou', '#manhwa', '#anime'],
  'ReturnOfMountHua':      ['#ReturnOfMountHua', '#manhwa', '#murim', '#manhwalover'],
  'NorthernBlade':         ['#NorthernBlade', '#manhwa', '#murim'],
  'HeavenlyDemon':         ['#HeavenlyDemonReborn', '#manhwa', '#murim', '#manhwalover'],
  'Noblesse':              ['#Noblesse', '#manhwa', '#anime', '#manhwafan'],
  'Frankenstein':          ['#Noblesse', '#manhwa', '#anime'],
  'Eleceed':               ['#Eleceed', '#manhwa', '#manhwalover'],
  'GodOfHighSchool':       ['#GodOfHighSchool', '#GOHS', '#manhwa', '#anime'],
  'GOHS':                  ['#GodOfHighSchool', '#manhwa', '#anime'],
  'MercenaryEnrollment':   ['#MercenaryEnrollment', '#manhwa', '#manhwalover'],
  'MurimLogin':            ['#MurimLogin', '#manhwa', '#murim'],
  'SwordMastersYoungestSon':['#SwordMastersYoungestSon', '#manhwa', '#manhwalover'],
  'TombRaiderKing':        ['#TombRaiderKing', '#manhwa', '#manhwafan'],
  'DungeonReset':          ['#DungeonReset', '#manhwa', '#manhwalover'],
  'RankersReturn':         ['#RankersReturn', '#manhwa', '#manhwafan'],
  'MaxLevelReturner':      ['#MaxLevelReturner', '#manhwa', '#manhwalover'],
  'HeroReturns':           ['#HeroReturns', '#manhwa', '#manhwafan'],
  'VolcanicAge':           ['#VolcanicAge', '#manhwa', '#murim'],
  'RegressedMercenary':    ['#manhwa', '#manhwalover', '#murim'],
  'TheBreaker':            ['#TheBreaker', '#manhwa', '#murim', '#manhwafan'],
  'LV999':                 ['#LV999', '#manhwa', '#manhwalover'],
  'AbsoluteSwordSense':    ['#AbsoluteSwordSense', '#manhwa', '#murim'],
  'SuicidalBattleGod':     ['#SuicidalBattleGod', '#manhwa', '#manhwalover'],
  'PickMeUp':              ['#PickMeUp', '#manhwa', '#manhwafan'],
};

const FALLBACK = ['#manga', '#manhwa', '#anime', '#otaku', '#animefan'];
const MAX_HASHTAGS = 5;
const TWEET_LIMIT = 280;

function appendHashtags(tweetText, tags = []) {
  // Collect hashtags from matching tags, deduplicated
  const seen = new Set();
  const pool = [];

  for (const tag of tags) {
    for (const ht of (TAG_MAP[tag] || [])) {
      if (!seen.has(ht)) { seen.add(ht); pool.push(ht); }
    }
  }

  // Fill remaining slots from fallback if pool is thin
  for (const ht of FALLBACK) {
    if (pool.length >= MAX_HASHTAGS) break;
    if (!seen.has(ht)) { seen.add(ht); pool.push(ht); }
  }

  const selected = pool.slice(0, MAX_HASHTAGS);

  // Append only hashtags that keep the tweet within 280 chars
  let result = tweetText;
  for (const ht of selected) {
    const candidate = result + '\n' + ht;
    if (candidate.length <= TWEET_LIMIT) result = candidate;
  }

  return result;
}

module.exports = { appendHashtags };
