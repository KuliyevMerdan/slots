# ADR-0002 — Money is integer minor units, and the brand lives in `protocol`

- **Status:** accepted
- **Date:** 2026-08-17
- **Applies to:** `@slot/protocol`, `@slot/money`, and every package that touches an amount.

## Context

A slot moves money on every spin. Two questions had to be answered before any of it was written:

1. **What is an amount?** A floating-point major unit (`12.34`) is the default in JavaScript and is
   wrong: `0.1 + 0.2` is famously not `0.3`, and a balance that drifts by a cent over a session is a
   support ticket that nobody can reproduce.
2. **Who owns the type?** The brand that makes an amount unmistakable has to exist somewhere, and
   the dependency table in `CLAUDE.md` said both candidates — `protocol` and `money` — depend on
   nothing.

## Decision

**Amounts are integer minor units** (cents, pence, öre) behind a branded type:

```ts
export type Minor = number & { readonly __brand: 'Minor' };
```

**The brand lives in `@slot/protocol`, and `@slot/money` depends on `protocol`.** The dependency
table changes accordingly: `money → protocol`.

The reason is where the guarantee has to hold. Every amount enters the client at the wire boundary,
through a zod schema. If the schema produced a plain `number`, the brand would be applied — at best —
by hand afterwards, which is precisely the moment it is worth having. So the schema itself produces
`Minor`, and that requires the type to be in the package that owns the schemas.

`money` then owns everything you *do* with an amount: exact arithmetic and the single formatting seam
at the edge of the UI.

**Every operation in `money` is exact or it throws.** There is no rounding mode, because nothing in
this game needs one: paytable multipliers are integers, and every bet level is a whole multiple of
the payline count, so a line bet is exact integer division. `divideExact` refuses a remainder rather
than rounding it away, and `multiply` refuses a fractional factor. The day a genuinely fractional
operation appears, it will be a decision someone makes on purpose — not a silently dropped cent.

## Consequences

**Good**

- `stake + 0.1` is a compile error. So is passing a raw `number` where an amount is expected.
- Money arithmetic is exact by construction, and the exactness is a property of the *bet levels*, not
  a convention someone has to remember.
- `Minor` survives validation: `SpinResSchema.parse(json).balance` is already branded.
- Formatting happens in exactly one place, and derives the number of minor digits from `Intl` rather
  than assuming 2 — JPY has 0 and KWD has 3, and a slot that shows `¥12.34` is not shippable in that
  market.

**Costs, accepted**

- `money` is no longer dependency-free. It is a type-only dependency, and `protocol` still depends on
  nothing, which is what keeps it publishable on its own (the stronger of the two properties).
- Constructing an amount from a plain number requires going through `minor()` or a schema. That is
  the friction working as designed.

## Alternatives rejected

- **`money` owns the brand, `protocol` imports it.** Inverts the more valuable independence:
  `protocol` is the package that would be handed to an operator's team, and it should carry no
  workspace dependencies at all.
- **Both packages declare a structurally identical brand.** TypeScript would accept it — the brands
  are structural — and the single most safety-critical type in the codebase would exist in two
  places, free to drift.
- **Decimal library (`decimal.js`, `big.js`).** Correct, and unnecessary: integers in a currency's
  minor unit are exact, and a slot has no compound-interest arithmetic. It would cost a dependency,
  bundle size in a game that has a load-time budget, and allocation in code that runs per frame.
- **Floating-point major units, rounded at the edges.** The default, and the one this decision
  exists to prevent.
