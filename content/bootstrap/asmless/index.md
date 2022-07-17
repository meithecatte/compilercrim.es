+++
title = "Branches: No assembly required"
date = "2021-06-29"
+++

[Last time,][prev] we started from the barebones [Miniforth kernel],[^kernel] and
implemented branches by writing additional primitive words in assembly. For
pragmatic reasons, that is the road I will be pursuing further, but I noticed
that it is also possible to implement branches in pure Forth. I believe that
this approach is quite interesting, so let's take a detour and get a closer
look. <!-- more -->

The relevant[^relevant] available primitives are:

```
+ - ! @ c! c@ dup drop swap emit u. >r r> [ ] : ;
```

Additionally, we have the implementations of the following from [the previous
post][prev]:

- system variables `latest`, `st`, `base`, `dp`, `disk#`
- dictionary space access: `here`, `allot`, `,`, `c,`
- defining words `create`, `variable`, `constant`
- some miscellanea: `+!`, `cell+`, `cells`, `compile`, `immediate`, `lit,`

You can fire up Miniforth by following the instructions in [the GitHub
repo][github]. If you'd like to try implementing pure-Forth branches on your
own, now is the time to stop reading. Otherwise, we'll be studying [the branches
on the `purity`, uh, branch][purity].

## Unconditional branches

When `(branch)` or `(0branch)` is compiled into a word, it will be immediately
followed by the branch target's address:

![Diagram demonstrates the compilation strategy for an if-else structure. IF
compiles to two cells, where the first one is (0branch), and the second one is
the jump target, which points just after the ELSE. Before that jump target, ELSE
introduces an unconditional (branch) to the position of THEN.](../branches/branches.svg)

Implementing the unconditional branch isn't that complicated — manipulate the
return stack to repoint the return address:

```fth
: (branch)
  r>  \ pop the return address, which points at the cell containing jump target
  @   \ fetch the jump target
  >r  \ make it the new return address
;
```

## Conditional branches

Clearly, the difficulty in a conditional branch boils down to choosing between
the two possible values for the return address. This would be quite simple if we
had `and` and `0=` — since Forth's `true` has all bits set, we can `and` with a
boolean flag to decide between a value of our choice and 0.[^bitwise]

This is easiest to use if we encode our branches as an offset, instead of an
absolute address. In this case, the implementation would look like this:

```fth
: (0branch)
  0=              ( should-jump )
  r> dup cell+    ( should-jump addr-of-offset retaddr-if-false )
  >r @ and r>     ( offset|0 retaddr-if-false )
  + >r
;
```

Sadly, we don't have `and` or `0=`. However, this is still a useful starting
point. Could we, perhaps, implement these words somehow?

## Shifting the bits around

It would be nice if we could extract out individual bits out of a word. If we
had that, we could implement bitwise functions by shifting out the input,
computing what we need bit by bit, and shifting in the result:

![](shifting.svg)

Shifting left is easy enough, as that's just multiplication by two:

```fth
: 2* dup + ;
```

However, getting a bit to the least-significant position is trickier. If we
leverage a memory access, though, we can extract the higher byte of a
value:[^little-endian]

```fth
variable x
: lobyte x ! x c@ ;
: hibyte x ! x 1 + c@ ;
```

This is essentially an 8-bit right shift. Let's use this to check if a number is
zero. We'd need to OR all the bits together, but we don't have `or` either.
Addition is somewhat similar, though, so let's count the bits in a value.

`s ( c v -- c' v' )` handles one iteration of the "loop" — it will shift out a
bit out of the 8-bit wide value `v`, and add it to the counter `c`.

```fth
: s 2* dup >r hibyte + r> lobyte ;
```

Running this 8 times will count the bits in a byte, so that's what `nb`
(`n`umber of `b`its) does:

```fth
: nb 0 swap s s s s s s s s drop ;
```

`nbw` (`n`umber of `b`its in a `w`ord) does the same for a full 16-bit value, by
invoking `nb` on each half:

```fth
: nbw dup hibyte nb swap lobyte nb + ;
```

How do we turn this into a comparison with zero? We iterate `nb` a few times:

- after `nbw`, you'll have a value that's at most 16,
- after `nbw nb`, you'll have a value that's at most 4,
- after `nbw nb nb`, you'll have a value that's at most 2,
- after `nbw nb nb nb`, you'll have a value that's either 0 or 1.

```fth
: 1bit nbw nb nb nb ;
```

## Choosing between values

While we could use a similar bitshifting strategy to implement `and` and choose
between the two return addresses using that, there is a simpler way: use the
1-bit value we compute to index into an array.[^movfuscator] We'll use a 2-entry
array called the `b`ranch `b`uffer:

```fth
create bb 2 cells allot
: (0branch)
  r> dup              \ two copies
  @ bb !              \ bb[0] = return address if 0 on the stack
  cell+ bb cell+ !    \ bb[1] = return address if something else on the stack
  1bit cells bb + @ >r
;
```

## Other solutions: a time-memory tradeoff

While elegant, our solution is quite inefficient, executing thousands of
instructions on every branch. While I wouldn't expect the best performance when
we're limiting ourselves to no additional assembly, there still are ways to make this
better.

For example, we could prepare a 256-byte lookup table for `1bit`. Since we don't
have any way to loop, we'll need to repeat things manually. Since 255 = 3 × 5
× 17, it could look like this:

```fth
: x 1 c, ;      \ write 1 one
: y x x x ;     \ write 3 ones
: z y y y y y ; \ write 15 ones
create tab 0 c,
z z z z z z z z z z z z z z z z z     \ 17 times
: 1bit-half tab + c@ ;
: 1bit dup hibyte 1bit-half swap lobyte 1bit-half + 1bit-half ;
```

## Is that all?

Yup, we're done. The [rest of the code][block2] needed to define `if`, `then`,
and other control-flow words looks exactly like in the previous post.

You might ask, is that everything we need for Turing-completeness?[^turing]
Perhaps there's a primitive we won't be able to define for some reason? I don't
think we need to worry. Our branch can be used to implement a loop-until-zero
control structure, and that's all [brainfuck] has.

Thus, I will end this digression here and continue bootstrapping without
artificially limiting my usage of assembly. Next on our agenda, we've got
Forth's exception handling mechanisms, and how to extend them for better error
messages than the bare minimum usually encountered in Forth.

{{ get_notified() }}

---

[^kernel]: The word "kernel" is used here in the language implementation sense,
  and not the operating system one. If you know a better term than this, please
  let me know, as there *will* be a point where I'll have to talk about both
  things at once...

[^relevant]: I'm skipping `load` and `s:`, since they won't help, and describing
  them is out of scope for this post. I describe them in [the previous
  post][prev] if you're curious.

[^bitwise]: This approach seems to have been independently invented at least
  three times: by [me][bitwise-me], [Cesar Blum][bitwise-sector], and [Paul
  Sleigh][bitwise-comment].

[^little-endian]: Recall that x86 is little-endian, and as such, a value like
  `1234` is stored as `34 12` in memory.

[^movfuscator]: I believe I learned this technique from the
  [M/o/Vfuscator][mov].

[^turing]: Well, since memory is finite, everything we've actually ever made is
  just a very large state machine. I suppose a closer notion would be
  [LBA-completeness][LBA] if we're being pedantic, but I wouldn't hope for a
  fully formal definition that captures what we usually mean by
  "Turing-complete" when talking about things that actually exist.

[prev]: @/bootstrap/branches/index.md
[Miniforth kernel]: @/bootstrap/miniforth/index.md
[github]: https://github.com/meithecatte/miniforth/tree/post2#building-a-disk-image
[purity]: https://github.com/meithecatte/miniforth/blob/purity/block1.fth
[brainfuck]: https://esolangs.org/wiki/Brainfuck
[LBA]: https://en.wikipedia.org/wiki/Linear_bounded_automaton
[bitwise-me]: https://github.com/meithecatte/2klinux/blob/b4f435cd0c265b9bee28d02be6d1fc177f3847b3/image-files/stage1.frt#L130
[bitwise-sector]: https://github.com/cesarblum/sectorforth/blob/32031ac6e77e30817c2f65ba11b1ccda07d564f9/examples/01-helloworld.f#L55-L57
[bitwise-comment]: https://github.com/meithecatte/compilercrim.es/issues/2#issuecomment-867288663
[mov]: https://www.youtube.com/watch?v=R7EEoWg6Ekk
[block2]: https://github.com/meithecatte/miniforth/blob/purity/block2.fth
[rss]: /rss.xml
