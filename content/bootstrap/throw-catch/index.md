+++
title = "How Forth implements exceptions"
date = "2021-09-20 12:00:00"
+++

Considering Forth's low-level nature, some might consider it surprising how
well-suited it is to handling exceptions. But indeed, ANS Forth does specify a
simple exception handling mechanism. As Forth doesn't have a typesystem capable
of supporting a mechanism like Rust's `Result`, exceptions are the preferred
error handling strategy. Let's take a closer look at how they're used, and how
they're implemented.  <!-- more -->

![A Pokémon Red textbox saying "Aww! It appeared to be caught!"](quote.png)

## A user's perspective

The exception mechanism consists of two user-facing words: `catch` and `throw`.
Unlike other control flow words, which act as additional syntax, `catch` merely
wants an execution token[^xt] at the top of the stack, which usually means that
`[']` will be used to obtain one just before the call to `catch` (though outside
of a definition, `'` is used instead).

If `execute`ing the execution token passed to `catch` it doesn't throw anything,
`catch` will push a `0` to indicate success:

```forth
42 ' dup catch .s ( <3> 42 42 0  ok )
```

On the other hand, if `throw` *is* executed, `throw`'s argument is left on the
stack to indicate the exception's type:

```forth
: welp 7 throw ;
1 2 ' welp catch .s ( <3> 1 2 7  ok )
```

The stack elements below this exception code are not just what was there when
`throw` was ran, though — if there's more than one possible `throw` location,
the layout of the stack would become unpredictable. That is why `catch`
remembers the stack depth, such that `throw` may restore it. As a result,
if our `welp` pushes additional elements onto the stack, they'll get discarded:

```forth
: welp 3 4 5 7 throw ;
1 2 ' welp catch .s ( <3> 1 2 7  ok )
```

and if it consumes some stack items, their place will be filled by uninitialized
slots when the stack pointer is moved:

```forth
: welp 2drop 2drop 7 throw ;
1 2 3 4 ' welp catch .s ( <5> 140620924927952 7 140620924967784 56 7  ok )
```

The way to think about it is to consider the stack effect of `' foo catch` as a
whole. For example, if `foo` has a stack effect of `( a b c -- d )`, then
`' foo catch` has `( a b c -- d 0 | x1 x2 x3 exn )`, where the `x?` are
the slots taken up by the arguments `a b c`, which could've been replaced with
pretty much any value, and thus can only be dropped.

What's key here is that the *amount* of items on the stack becomes known, and
now we can safely discard what could've been touched by `foo`, to access
anything we might've been storing below.

Let's take a look at a fuller example of how this can all be used. Suppose we
have a `/` word that implements division, but crashes if you attempt to divide
by zero. Let's wrap it with a quick check that throws an exception instead.

First, we'll need to choose an integer that'll signify our exception's type.
There aren't any conventions as to how this should be done, except for some
reserved values:

 - `0` is used by `catch` to signify "no exception"
 - values in the range `{-255...-1}` are reserved for errors defined by the
   standard
 - values in the range `{-4095...-256}` are reserved for errors defined by the
   Forth implementation

Since the standard assigns an identifier for "division by zero", we might as
well use it.

```forth
-10 constant exn:div0
```

I couldn't actually find any guidance on how these are typically picked for
application-specific exceptions. If I had to guess, one'd start with small
positive integers, rather than at `-4096` going down. For what it's worth,
[Miniforth's extended exception mechanism][next post] sidesteps this by
using memory addresses as identifiers.

Anyway, throwing an exception looks exactly like what you'd expect:

```forth
: / ( a b -- a/b )
  dup 0= if
    exn:div0 throw
  then / ( previous, unguarded definition of / — not recursion )
;
```

You could then use it like so:

```forth
: /. ( a b -- )
  over . ." divided by " dup . ." is "
  ['] / catch if
    2drop ( / takes 2 arguments, so we need to drop 2 slots )
    ." infinity" ( sad math pedant noises )
  else . then ;
```

This works just as you'd expect it to:

<pre>
<b>7 4 /.</b> 7 divided by 4 is 1  ok
<b>7 0 /.</b> 7 divided by 0 is infinity ok
</pre>

Of course, checking for a zero divisor explicitly would probably make more sense
in this case, but a more realistic example would obscure the details of
exception handling too much...

### `0 throw` and its uses

Before we look into the implementation of `throw` and `catch` themselves, I'd
like to highlight one more special case. Specifically, `throw` checks whether
the exception number is zero, and if it is, doesn't actually throw it — `0
throw` is always a no-op.

There are a few aspects as to why this is the case. Firstly, actually throwing a
zero would be confusing, as `catch` uses zero to signify that no exception was
caught. But hold on, it's not exactly in character for Forth to check for this.
There's plenty of other ways to fuck up already. They could've said "it'll eat
a sock if you try to do that" and celebrated the performance win.

And even if you do check, why make it a no-op? Shouldn't you throw a "tried to
throw a zero" exception instead, to make sure the mistake is noticed?

The answer, simply enough, is that it's not necessarily a mistake. There are
some useful idioms that center around `0 throw` being a no-op.

One concerns a more succint way for checking a condition:

```forth
: / ( a b -- a/b )
  dup 0= exn:div0 and throw / ;
```

This works since, in Forth, the canonical value for `true` has all the bits set
(unlike C, which only sets the lowest bit), so `true exn:div0 and` evaluates
to `exn:div0`. Of course, when using this idiom, one must be careful to use a
canonically-encoded flag, and not something that may return arbitrary values
that happen to be truthy.

The other idiom allows exposing an error-code based interface, that can be
conveniently used as an exception-based one. For example, `allocate` (which
allocates memory dynamically like C's `malloc`) has the stack effect
`size -- ptr err`. If the caller wants to handle the allocation failure here
and now, it can do

```
... allocate if ( it failed :/ ) exit then
( happy path )
```

But throwing an exception when an error is returned only requires `allocate
throw` --- if no error occurred, the `0` will get dropped.

## The internals

Now, how is this sausage made? [`jonesforth`], a very popular [literate
programming] implementation of Forth, [suggests][jonesforth-impl] implementing
exceptions by, essentially, having `throw` scan the return stack for a specific
address within the implementation of `catch`. This feels like something one
would come up with after studying the complex unwinding mechanisms in languages
like C++ or Rust — they too unwind the stack, using some very complex support
machinery spanning the entire toolchain. However, the reason they need to do
that is to run the destructors of objects in the stack frames that are about to
get discarded.

Forth, as you're probably aware, does not have destructors. This allows for
a much simpler solution — instead of scanning the return stack for the position
where `catch` was most recently executed, we can just have `catch` save this position
in a variable.

```forth
variable catch-rp ( return [stack] pointer at CATCH time )
```

Apart from the simplicity, this approach also has performance[^ats] and robustness
advantages — remember that `>r` and do-loops can also push things onto the
return stack. It would be a great shame if such a value happened to equal the
special marker address that's being scanned for...[^sec]

To support nested invocations of `catch`, we'll need to save the previous value
of `catch-rp` on the stack. While we're at it, this is also a good place to save
the parameter stack pointer. This effectively creates a linked list of "exception
handling frames", allocated on the return stack:

![The catch-rp variable points into the return stack, just above its own saved
value.](catch-rstack1.svg)

Note that the "return to `catch`" entry is *above* the data pushed by `catch`.
This is because the former only gets pushed once `catch` calls a non-assembly
word — in this case, the `execute` that ultimately consumes the execution token.

### Some assembly required

Since the stack pointers themselves aren't exposed as part of the Forth
programming model, we'll need to write some words in assembly to manipulate
them. The words for the return stack pointer are straight-forward:

```forth
:code rp@ ( -- rp ) bx push, di bx movw-rr, next,
:code rp! ( rp -- ) bx di movw-rr, bx pop, next,
```

(this syntax (as well as the implementation of the assembler) was explained
[in a previous article][asm])

Manipulating the data stack pointer is a bit harder to keep track of, as the value
of the stack pointer itself goes through the data stack. I ended up choosing the
following rule: `sp@` pushes the pointer to the element that was at the top
before `sp@` was executed. In particular, this means `sp@ @` does the same thing
as `dup`:

![The saved stack pointer points to the value just above it on the
stack](spat.svg)

This diagram bends the reality a little, as [the top of the stack is kept in
`bx`, and not in memory][tos-bx], as an optimization. Thus, we first need to
store `bx` into memory:

```forth
:code sp@ bx push, sp bx movw-rr, next,
```

`sp!` works similarly, with the guiding principle that `sp@ sp!` should be a
no-op:

```forth
:code sp! bx sp movw-rr, bx pop, next,
```

Note that there aren't actually any implementation differences between
`sp@`/`sp!` and their return stack counterparts (apart from using the `sp`
register instead of `di`). You just need to think more about one than about the
other...

The last `:code` word we'll need is `execute`, which takes an execution token
and jumps to it.

```forth
:code execute bx ax movw-rr, bx pop, ax jmp-r,
```

Interestingly, `execute` doesn't actually *need* to be implemented in assembly.
We could just as well do it in Forth with some assumptions on how the code gets
compiled — write the execution token into the compiled representation of
`execute` itself, just before we reach the point when it gets read:

```forth
: execute [ here 3 cells + ] literal !
  ( any word can go here, so... ) drop ; ( chosen by a fair dice roll... )
```

This kind of trickery is unnecessarily clever in my opinion, though. It doesn't
actually have any portability advantages, since it assumes so much about the
Forth implementation it's running on, and on top of that, it's probably larger
and slower. Still, it's interesting enough to mention, even if we don't actually
use it in the end.

### Putting it all together

Let's take another look at how the return stack should look:

![The saved sp is pushed first, then saved catch-rp, and then the return stack
pointer is sampled and saved to catch-rp.](catch-rstack2.svg)

Let's construct that, then:

```forth
: catch ( i*x xt -- j*x 0 | i*x n )
  sp@ >r  catch-rp @ >r
  rp@ catch-rp !
```

Then, it's time to `execute`. It will only actually return if no exception is
thrown, so next we handle the happy path by pushing a `0`:

```forth
  execute 0
```

Finally, we pop what we pushed onto the return stack. The previous value of
`catch-rp` does need to get restored, but the data stack pointer needs to get
dropped, as we aren't supposed to restore the stack depth in this case.

```forth,hide_lines=1
: x
  r> catch-rp ! rdrop ;
```

`throw` begins by making sure that the exception code is non-zero, and then
rolls back the return stack to the saved location.

```forth
: throw  dup if
  catch-rp @ rp!
```

Restoring `catch-rp` happens just as you'd expect:

```forth
  r> catch-rp !
```

The saved SP is somewhat harder. Firstly, we don't want to lose the exception
code, so we'll need to save it on the return stack before restoring SP:

```forth
  r> swap >r sp!
```

Secondly, when `sp@` was ran, the execution token was still on the stack — we
need to remove that stack slot before pushing the exception code in its place:

```forth,hide_lines=1
: x
  drop r>
else ( the 0 throw case ) drop then ;
```

## But wait, there's more!

We've seen how the standard exception mechanism works in Forth. The facilities
of throw-and-catch are provided, but in quite a rudimentary form.
In my [next post], I explain how Miniforth builds upon this mechanism to attach
*context* to the exceptions, resulting in actionable error messages when the
exception bubbles up to the top-level. See you there!

{{ get_notified() }}

---

[^xt]: Forth-speak for "function pointer".

[^ats]: One would think that the performance of exceptions shouldn't ever become
  the bottleneck. I agree, though I would like to take this opportunity to point
  out a style of programming I've recently seen in which the performance of
  exception handling indeed matters. Namely, take a look at the examples in the
  Exceptions section of the [ATS manual]. Viewer discretion advised.

[^sec]: This could probably have some security implications, but hopefully
  nobody writes security-critical stuff in Forth anyway. Considering where we're
  at with C, though...

[`jonesforth`]: https://github.com/nornagon/jonesforth
[literate programming]: https://en.wikipedia.org/wiki/Literate_programming
[jonesforth-impl]: https://github.com/nornagon/jonesforth/blob/4f853252f715132e7716cbd44e5306cefb6a6fec/jonesforth.f#L1193
[ATS manual]: http://ats-lang.github.io/DOCUMENT/INT2PROGINATS/PDF/main.pdf#12.44.1
[asm]: @/bootstrap/branches/index.md#forth-style-assemblers
[tos-bx]: /bootstrap/miniforth/#tos-bx
[execute-pure]: https://github.com/NieDzejkob/2klinux/blob/b4f435cd0c265b9bee28d02be6d1fc177f3847b3/image-files/stage1.frt#L700-L702
[next post]: @/bootstrap/exception-context/index.md
