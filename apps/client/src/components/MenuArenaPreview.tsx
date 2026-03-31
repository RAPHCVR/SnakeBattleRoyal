export function MenuArenaPreview() {
  return (
    <div className="arena-placeholder" aria-hidden="true">
      <div className="arena-placeholder__glow arena-placeholder__glow--teal" />
      <div className="arena-placeholder__glow arena-placeholder__glow--orange" />
      <div className="arena-placeholder__grid" />

      <div className="arena-placeholder__snake arena-placeholder__snake--player1">
        <span />
        <span />
        <span />
      </div>

      <div className="arena-placeholder__snake arena-placeholder__snake--player2">
        <span />
        <span />
        <span />
      </div>

      <div className="arena-placeholder__food" />
    </div>
  );
}
