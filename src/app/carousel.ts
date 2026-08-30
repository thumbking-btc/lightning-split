export function scrollCarouselToIndex(
  carousel:
    { readonly children: { item(index: number): unknown } } | null | undefined,
  index: number,
  behavior: ScrollBehavior,
): boolean {
  const card = carousel?.children.item(index) as
    | { scrollIntoView?: (options: ScrollIntoViewOptions) => void }
    | null
    | undefined;
  if (typeof card?.scrollIntoView !== "function") return false;
  card.scrollIntoView({ behavior, block: "nearest", inline: "center" });
  return true;
}
