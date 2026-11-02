// Ranking Engine: recency decay boosted by engagement.
//   score = (1 + likeWeight * ln(1 + likes)) * 0.5 ^ (ageHours / halfLifeHours)
// Pure function so it can be unit-tested and later swapped for an ML model.
const DEFAULTS = { halfLifeHours: 6, likeWeight: 0.3 };

function scorePost(post, now, { halfLifeHours, likeWeight }) {
  const ageHours = Math.max(0, (now - new Date(post.createdAt).getTime()) / 3_600_000);
  const engagement = 1 + likeWeight * Math.log1p(post.likeCount || 0);
  return engagement * Math.pow(0.5, ageHours / halfLifeHours);
}

function rankPosts(posts, { now = Date.now(), ...options } = {}) {
  const opts = { ...DEFAULTS, ...options };
  return posts
    .map((post) => ({ ...post, score: Number(scorePost(post, now, opts).toFixed(6)) }))
    .sort((a, b) => b.score - a.score || new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { rankPosts, scorePost, DEFAULTS };
