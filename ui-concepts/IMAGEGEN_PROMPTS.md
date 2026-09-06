# SIDE UI concept prompts

Generation mode: built-in ImageGen.

> SIDE-001 runtime note (frozen 2026-09-04): the existing cockpit images illustrate the broader M0 venue layout and contain simulated labels. The S0 implementation must instead show the selected atomic CEX profile (`Coinbase SOL-USD + Coinbase Derivatives SLP`, or `Binance spot + perp` fallback), Hyperliquid, and `BITQUERY-DECODED SOLANA DEX FLOW`. Paper estimates use 0x primary and an explicitly selected Jupiter fallback. Do not interpret older prompt labels as S0 source requirements.

## Main cockpit

```text
Use case: ui-mockup
Asset type: high-fidelity desktop web app concept screenshot for a short-window trading decision tool
Primary request: design the main dashboard for a product named "SIDE", a SOL-only cross-market consensus cockpit. It helps an active trader decide whether fragmented markets confirm a short-horizon directional trade. This is a realistic, shippable product UI, not concept art.
Scene/backdrop: full-bleed 16:9 desktop application on a near-black graphite background.
Style/medium: premium institutional trading interface with restrained sci-fi character; precise grid; excellent spacing; crisp sans-serif typography; subtle glow only on live status and directional accents.
Composition/framing: top bar with exact text "SIDE", "SOL / USD", "LIVE", "PAPER MODE", and a data freshness indicator. Main center decision card with exact text "NO EDGE", "MARKET DISAGREEMENT: HIGH", and a smaller sentence "Spot buying. Perps fading. Leverage rising." Surround it with four equal evidence modules labeled exactly "CEX SPOT", "CEX PERPS", "DEX SPOT", "DEFI PERPS". Each module must show a simple verdict BUY, SELL, or NEUTRAL and only 2-3 compact metrics. Use venue names as plain text: Binance, KuCoin, OKX, Hyperliquid, SOL-USDC, SOL-USDT. Bottom strip labeled "PRICE DISCOVERY" with a small multi-line lead/lag chart, and "5M SHADOW PERFORMANCE" with a minimal sparkline. Include two modest actions: "PAPER BUY" and "PAPER SELL"; they must not dominate the verdict.
Color palette: graphite black, warm white, muted slate; acid green for BUY, coral red for SELL, amber for warnings, cyan for neutral/live.
Text (verbatim): "SIDE", "SOL / USD", "LIVE", "PAPER MODE", "NO EDGE", "MARKET DISAGREEMENT: HIGH", "Spot buying. Perps fading. Leverage rising.", "CEX SPOT", "CEX PERPS", "DEX SPOT", "DEFI PERPS", "PRICE DISCOVERY", "5M SHADOW PERFORMANCE", "PAPER BUY", "PAPER SELL"
Constraints: one desktop screen; information-dense but calm; strong visual hierarchy; every displayed number should look plausible but is illustrative; no candlestick chart; no technical indicators; no news or social sentiment; no AI badge; no exchange logos; no crypto coin illustrations; no wallet-connect action; no real trading action; no watermark.
Avoid: casino aesthetic, neon overload, cyberpunk scenery, clutter, giant buy/sell buttons, black-box confidence score, gradients behind text.
```

## Paper order - base generation

```text
Use case: ui-mockup
Asset type: high-fidelity desktop web app concept screenshot showing the paper-trade flow for the crypto product "SIDE"
Primary request: show the same near-black institutional SOL market-consensus dashboard dimmed in the background, with a focused right-side paper order review drawer. The flow must communicate deliberate execution quality and post-trade validation, not gambling.
Scene/backdrop: full-bleed 16:9 desktop app, graphite black with a precise grid and crisp panels.
Style/medium: realistic shippable product UI; calm institutional terminal; restrained sci-fi; strong typography and spacing; subtle color accents.
Composition/framing: background contains a compact verdict card reading "BUY BIAS" and market evidence tiles. Foreground right drawer title exact text "PAPER ORDER". Include side segmented control "BUY" and "SELL", notional field "$10,000", execution reference "DEX EXECUTABLE QUOTE", pair "SOL-USDC", quote age "0.8s", expected amount "56.71 SOL", price impact "3.2 bps", fees "1.0 bp", and a clear warning if data becomes stale. Include a small expandable row "WHY THIS PRICE?" that reveals three plain-English lines: "Best executable route", "Network and protocol fees included", "Measured at decision time". Primary button exact text "RECORD PAPER BUY". Beneath it, a quiet note exact text "No wallet. No funds. Nothing onchain." Also show a small post-trade evaluation preview at the bottom labeled "5M MARKOUT" with "Pending" and a timeline from Decision to +5m.
Color palette: graphite black, warm white, muted slate, acid green for buy, amber for freshness warning, cyan for neutral information.
Text (verbatim): "SIDE", "BUY BIAS", "PAPER ORDER", "BUY", "SELL", "$10,000", "DEX EXECUTABLE QUOTE", "SOL-USDC", "0.8s", "56.71 SOL", "3.2 bps", "1.0 bp", "WHY THIS PRICE?", "Best executable route", "Network and protocol fees included", "Measured at decision time", "RECORD PAPER BUY", "No wallet. No funds. Nothing onchain.", "5M MARKOUT", "Pending", "Decision", "+5m"
Constraints: one desktop screen; high legibility; no real wallet or connect button; no private key; no exchange logos; no technical indicators; no news; no AI label; no watermark. Use modest, trustworthy controls with clear review hierarchy.
Avoid: casino aesthetic, oversized action button, neon overload, cyberpunk scenery, clutter, slippage hidden in fine print, real trade confirmation.
```

## Paper order - final targeted edit

```text
Use case: precise-object-edit
Asset type: high-fidelity desktop product UI mockup
Input images: Image 1: edit target, the most recent SIDE paper-order dashboard
Primary request: change only the dimmed dashboard area on the left. Remove the entire vertical navigation/sidebar, remove "MARKET REGIME", "SENTIMENT", "WATCHLIST", "BACKTEST", and remove the numeric confidence bar. Expand the dashboard to fill the left area with a compact central "BUY BIAS" verdict explained by four evidence cards labeled exactly "CEX SPOT", "CEX PERPS", "DEX SPOT", and "DEFI PERPS", plus a small "PRICE DISCOVERY" lead/lag chart along the bottom. Keep the paper-order drawer on the right unchanged in content, hierarchy, size, and position.
Constraints: preserve the right-side drawer and all its exact text; preserve the graphite palette, typography, lighting, and framing; no AI badge; no sentiment metric; no technical indicators; no casino aesthetic; no exchange logos; no wallet control; no watermark.
```

## Paper order - final text correction

```text
Use case: text-localization
Asset type: high-fidelity desktop product UI mockup
Input images: Image 1: edit target, the most recent SIDE paper-order dashboard
Primary request: replace only the malformed top-left header text "SÕL MARKET CONSENSUS" with the exact word "SIDE".
Text (verbatim): "SIDE"
Constraints: change only that top-left header; preserve every other pixel, label, value, panel, spacing, color, and the entire paper-order drawer unchanged; no new text; no watermark.
```

## Main cockpit - required-source and event-driven correction

```text
Use case: precise-object-edit
Asset type: high-fidelity desktop product UI mockup
Input images: Image 1: edit target, the most recent SIDE main cockpit
Primary request: preserve the graphite institutional trading-terminal composition, but correct the market-source model and make event flow visible. CEX SPOT must list Binance, KuCoin, and OKX. CEX PERPS must list Binance, KuCoin, and OKX only; remove Hyperliquid from that panel. DEX SPOT must have separate SOL-USDC and SOL-USDT lanes and show executable-quote semantics such as estimated output, minimum output, route change, and confirmed swap events. DEFI PERPS must contain Hyperliquid SOL-PERP only. Add restrained local event pulses at the lane where each event arrives, a normalized event tape, and sparse evidence tracers toward the central verdict only when a jury state changes. Keep the central verdict readable and calm.
Text (verbatim where shown): "SIDE", "SOL / USD", "PAPER MODE", "NO EDGE", "CEX SPOT", "CEX PERPS", "DEX SPOT", "DEFI PERPS", "Binance", "KuCoin", "OKX", "SOL-USDC", "SOL-USDT", "Hyperliquid", "NORMALIZED EVENT TAPE", "FIRST OBSERVED BY SIDE"
Constraints: every required venue appears in the correct panel; no duplicate Hyperliquid; no invented DEX net-flow or pool-depth metrics without a supporting source; no fixed 8h funding assumption; visual effects remain subtle and localized; no AI badge; no wallet control; no real-trade CTA; no watermark.
```

## Main cockpit - final status and metric-label correction

```text
Use case: text-localization
Asset type: high-fidelity desktop product UI mockup
Input images: Image 1: edit target, the most recent SIDE main cockpit
Primary request: make only these text corrections. Replace the top live claim with "CONCEPT · SIMULATED DATA". Replace any unsupported generic depth label with "Book imbalance +18.4%". Replace any fixed funding-period label with "Funding normalized". Preserve all source lanes, local event pulses, event tape, layout, values, colors, and spacing.
Text (verbatim): "CONCEPT · SIMULATED DATA", "Book imbalance +18.4%", "Funding normalized"
Constraints: no other edits; no watermark.
```

## Paper order - final API-semantics correction

```text
Use case: precise-object-edit
Asset type: high-fidelity desktop product UI mockup
Input images: Image 1: edit target, the most recent SIDE paper-order dashboard
Primary request: preserve the graphite layout and paper-order drawer, but correct the product and API semantics. Add "CONCEPT · SIMULATED DATA" in the header. In the left evidence area show four jury votes: CEX SPOT BUY, CEX PERPS BUY, DEX SPOT BUY, DEFI PERPS NEUTRAL. Rename the lower lead/lag label to "FIRST OBSERVED BY SIDE". In the drawer rename the quote section to "0x SOLANA ESTIMATE" and label 56.71 SOL as "ESTIMATED OUTPUT". Remove numeric price-impact and fee claims; replace both with "Not supplied by 0x". Keep "RECORD PAPER BUY" and "No wallet. No funds. Nothing onchain." prominent and legible.
Text (verbatim): "CONCEPT · SIMULATED DATA", "CEX SPOT", "CEX PERPS", "DEX SPOT", "DEFI PERPS", "BUY", "NEUTRAL", "FIRST OBSERVED BY SIDE", "0x SOLANA ESTIMATE", "ESTIMATED OUTPUT", "56.71 SOL", "PRICE IMPACT", "FEE BREAKDOWN", "Not supplied by 0x", "RECORD PAPER BUY", "No wallet. No funds. Nothing onchain."
Constraints: do not imply a firm quote, price-impact field, fee-breakdown field, wallet connection, signing, broadcast, or real-money execution; preserve the rest of the interface; no watermark.
```

## Paper order - final minimum-output addition

```text
Use case: precise-object-edit
Asset type: high-fidelity desktop product UI mockup
Input images: Image 1: edit target, the most recent corrected SIDE paper-order dashboard
Primary request: add one compact row directly below "ESTIMATED OUTPUT 56.71 SOL" reading "MINIMUM OUTPUT 56.42 SOL". Preserve every other label, value, panel, status, hierarchy, color, and position unchanged.
Text (verbatim): "MINIMUM OUTPUT", "56.42 SOL"
Constraints: change only the requested row; no watermark.
```

## Main cockpit - final first-observed label

```text
Use case: text-localization
Asset type: high-fidelity desktop product UI mockup
Input images: Image 1: edit target, the current SIDE main cockpit
Primary request: replace only the lower-left panel heading "PRICE DISCOVERY" with the exact text "FIRST OBSERVED BY SIDE". Preserve the chart, legend, values, all event pulses, the live event tape, every market panel, header, footer, colors, spacing, and all other text unchanged.
Text (verbatim): "FIRST OBSERVED BY SIDE"
Constraints: change only that one heading; no new elements; no watermark.
```

## Five-minute bubble quadrant - v1

```text
Use case: precise-object-edit
Asset type: high-fidelity 16:9 desktop web-app UI mockup for SIDE
Input images: Image 1 is the edit target and layout sketch; Image 2 is the supporting visual-style reference for graphite surfaces, typography, border treatment, restrained glow, header, and central verdict card.
Primary request: turn Image 1 into a polished institutional trading cockpit. Preserve the full-width SIDE header and the central floating verdict card concept. Replace every black or white placeholder area with one continuous near-black graphite application surface containing four large equal quadrants around the centered verdict.
Composition/framing: a strict 2-by-2 matrix. Top row represents SPOT, bottom row represents PERP. Left column represents BUY POWER, right column represents SELL POWER. Therefore the four large quadrant headings must be exactly: "SPOT · BUY POWER", "SPOT · SELL POWER", "PERP · BUY POWER", "PERP · SELL POWER". Each large quadrant is split vertically into two equal subpanels. In both SPOT quadrants label the subpanels "CEX" and "DEX". In both PERP quadrants label the subpanels "CEX" and "DEFI". Keep the center verdict card floating above the intersection of the four quadrants, compact enough that surrounding bubbles remain visible.
Bubble visualization: every one of the eight subpanels contains a live-looking field of non-overlapping translucent bubbles representing accepted buy or sell trade events from the rolling five-minute window. Bubble AREA, not diameter, maps to trade volume; mix several small bubbles with a few large ones. Buy-side bubbles use restrained acid green; sell-side bubbles use restrained coral red. Use thin outlines and subtle glow, never cartoon styling. Small muted venue labels may appear inside only the largest bubbles: Binance, KuCoin, OKX, Orca, Raydium, Hyperliquid. Do not put numeric text inside small bubbles.
Summary treatment: each of the eight subpanels has a compact fixed header band above its bubbles, similar to the evidence cards in Image 2. Show source type, accepted event count, total 5m volume, and percentage share. Use plausible illustrative values. The four large quadrants also show one concise aggregate at the outer corner, such as "5m buy volume" or "5m sell volume". Keep all summaries visually secondary to the bubble fields.
Central verdict card: exact main text "NO EDGE"; exact secondary text "MARKET DISAGREEMENT: HIGH"; exact explanation "Spot buying. Perps fading. Leverage rising."; two modest outline actions "PAPER BUY" and "PAPER SELL". Preserve the amber warning character and premium dotted texture of Image 2.
Header text (verbatim): "SIDE", "SOL / USD", "5 MIN WINDOW", "CONCEPT · SIMULATED DATA", "PAPER MODE", "Data age 1.2s". There is no timeframe picker and no other duration anywhere.
Visual hierarchy: the row labels SPOT and PERP and the column labels BUY POWER and SELL POWER must be immediately understandable. Add very subtle axis labels outside the matrix if useful, but do not duplicate headings excessively. Use a precise grid, fine slate separators, generous margins, warm white text, and no unused space.
Constraints: one full desktop screen; every placeholder filled; no candlesticks, price chart, technical indicators, order-entry form, sidebar, navigation menu, news, social sentiment, AI badge, exchange logos, wallet-connect control, real-money execution, watermark, or white background. This is a design concept with simulated values, not a live-data claim. Do not let bubbles overlap the summary header bands or central verdict text.
Avoid: casino aesthetic, neon overload, glossy 3D spheres, rainbow colors, giant buttons, illegible microtext, bubbles crossing quadrant boundaries, decorative charts, empty regions.
```

## Five-minute weighted bubble matrix - v2

```text
Use case: precise-object-edit
Asset type: high-fidelity 16:9 desktop web-app UI mockup for SIDE
Input images: Image 1 is the edit target, the current five-minute bubble quadrant design.
Primary request: replace the equal 2-by-2 quadrant geometry with a weighted, strength-responsive matrix while preserving the same SIDE visual system, bubble semantics, source summaries, header, and centered verdict card.
Weighted layout for this illustrative state: aggregate five-minute BUY POWER is 61% and SELL POWER is 39%, so move the main vertical buy/sell boundary to the right and give the left buy territory visibly more width than the right sell territory. Aggregate SPOT activity is 56% and PERP activity is 44%, so move the horizontal spot/perp boundary slightly downward and give the top row more height. These boundaries may pass behind the overlay, but they must never move the verdict card.
Central invariant: the NO EDGE verdict card remains locked exactly at the geometric center of the full application viewport, with the same size, content, buttons, amber styling, and highest z-index. It must not drift toward the larger territory and it must not resize.
Panel hierarchy: keep the four semantic regions "SPOT · BUY POWER", "SPOT · SELL POWER", "PERP · BUY POWER", and "PERP · SELL POWER". Keep CEX and DEX subpanels in Spot; keep CEX and DEFI subpanels in Perp. Within each region, subpanel widths may also differ modestly according to their displayed percentage shares, but retain clear minimum readable widths.
Strength indicators: add a restrained bottom horizontal balance scale reading exactly "BUY 61%" on the left and "SELL 39%" on the right, with the balance marker aligned to the shifted vertical boundary. Add a restrained left vertical balance scale reading exactly "SPOT 56%" above and "PERP 44%" below, aligned to the shifted horizontal boundary. These are explanatory axes, not controls.
Bubble behavior: preserve the non-overlapping translucent bubbles, with bubble AREA representing event volume. Reflow the bubble packing naturally into the newly sized regions. Do not stretch bubbles or let them cross their panel boundaries, summary bands, or the central verdict exclusion zone.
Header text remains: "SIDE", "SOL / USD", "5 MIN WINDOW", "CONCEPT · SIMULATED DATA", "PAPER MODE", "Data age 1.2s".
Constraints: change the region geometry and add only the two balance scales; preserve the graphite palette, typography, all eight source summary bands, event counts, volume totals, venue labels, buy green, sell coral, and all central verdict text. No empty white space, no timeframe picker, no candlesticks, no charts, no order form, no sidebar, no exchange logos, no wallet control, no watermark.
Avoid: equal quadrants, moving or resizing the central verdict, unstable-looking diagonal boundaries, distorted bubbles, unreadably narrow panels, excessive glow, casino styling.
```

## Five-minute weighted bubble matrix - v3

```text
Use case: precise-object-edit
Asset type: high-fidelity 16:9 desktop web-app UI mockup for SIDE
Input images: Image 1 is the edit target, the weighted five-minute bubble matrix.
Primary request: keep the strength-responsive BUY-versus-SELL width and the fixed centered verdict, but make SPOT and PERP equal-height rows. The user requested horizontal left/right weighting by aggregate buy/sell strength, not vertical spot/perp weighting.
Required changes: preserve the shifted vertical boundary and bottom scale "BUY 61%" / "SELL 39%" exactly. Move the horizontal SPOT/PERP boundary to exactly half the usable matrix height so the top and bottom rows are equal. Remove the left-axis percentages "56%" and "44%"; keep only simple row labels "SPOT" and "PERP" centered beside their equal-height rows. Do not add a spot/perp strength scale.
Central invariant: keep the NO EDGE verdict card locked exactly at the geometric center of the full viewport, unchanged in size, content, buttons, style, and z-index. It must remain centered even though the BUY region is wider.
Constraints: change only the horizontal row sizing and left row labels. Preserve all bubbles, reflowing them naturally if needed; preserve all eight source summary bands, event counts, values, venue labels, header, colors, bottom buy/sell balance scale, and shifted buy/sell boundary. No watermark.
```
