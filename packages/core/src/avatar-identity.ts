/**
 * A bot with no picked shape still needs a stable one: the seed hashes its id so
 * the same bot always lands on the same shape.
 */
export function avatarIdentitySeed(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index++) {
    hash = (hash << 5) - hash + identity.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
