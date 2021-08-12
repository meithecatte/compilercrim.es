+++
title = "How Forth implements exceptions"
date = "2021-08-11 12:00:00"
+++

Considering Forth's low-level nature, some might consider it surprising how
well-suited it is to handling exceptions. But ANS Forth specifies a nice and
simple mechanism which can be implemented quite elegantly. Let's take a closer
look.

## A user's perspective

The exception mechanism consists of two words: `catch` and `throw`.
Unlike other control flow, `catch` wants an execution token at the top of
the stack. If executing it doesn't throw anything, `catch` will push a `0` to
indicate that:

```forth
42 ' dup catch .s ( <3> 42 42 0  ok )
```

On the other hand, if `throw` is executed, it takes a numeric argument which is
then returned by `catch`.

```forth
: welp 7 throw ;
1 2 ' welp catch .s ( <3> 1 2 7  ok )
```

One potential issue involves the stack layout at the moment the exception is
thrown. After all, a lot of code could've been executed before we reached a
`throw`. This is why `catch` saves the current stack depth before executing the
xt passed as argument — if an exception gets thrown, the stack depth will get
restored:

```forth
: welp 3 4 5 7 throw ;
1 2 ' welp catch .s ( <3> 1 2 7  ok )
```

This does mean that uninitialized stack entries might get created:

```forth
: welp 2drop 2drop 7 throw ;
1 2 3 4 ' welp catch .s ( <5> 140620924927952 7 140620924967784 56 7  ok )
```

Apart from a reserved range, there aren't any rules as
to how this number should be chosen.

>  The THROW values `{-255...-1}` shall be used only as assigned by this standard. The values `{-4095...-256}` shall be used only as assigned by a system.
>
> Programs shall not define values for use with THROW in the range `{-4095...-1}`.

This *xt* will then be executed, and any exceptions will be caught.
If an exception *is* caught, the identifying number passed to `THROW` is left
at the top of the stack. Otherwise, a `0` is pushed, to signify that nothing was
caught.

Let's take a look at a simple example of how this can be used. First, we'll need
to choose an integer that'll signify our exception's type. ANS Forth doesn't
specify any mechanism for allocating those, so let's just choose a number:

```forth
-42 constant exn:its-odd
```

Now, we'll need something that'll throw our exception. For a simple example,
let's say we want a word `halve`, that will divide a number by two, or throw an
exception if it's odd:

```forth
: halve ( n -- n/2 )
  dup 1 and if
    exn:its-odd throw
  then 2/
;
```

Then, let's say `print-half` wants to use `halve`, but catch the exception if
the input was wrong:

```forth
: print-half ( n -- )
  ['] halve catch if
    drop ." :("
  else
    .
  then
;
```

If we test it in, say, Gforth, we'll see that it behaves as we'd expect:

<pre>
<b>42 try-halve</b> 21  ok
<b>1337 try-halve</b> :( ok
</pre>

That's all quite simple, but there's actually a smart aspect of this design.
Namely, if an exception is caught, the stack depth is reset to be the same as
when `catch` started executing. The stack effect used by the standard explains
this nicely:

```forth
catch ( i*x xt -- j*x 0 | i*x n )
```

Note that to describe the case where a `0` is pushed (and therefore no exception
occured), a `j` is used instead of `i` as the count, to signify that the stack
depth might be different.

This stack adjustment will merely move the stack pointer, so it can either drop
values or create unpredictable ones (though some implementations will choose to
explicitly push zeroes). This means that the only good thing we can do is drop
them.

However, the key is that the number of cells we need to drop is known.
If we called a word that takes 3 arguments, it probably did something to those
stack slots, but *nothing beneath them should've been changed*. This is why our
implementation of `print-half` has a `drop` — we need to discard the `n` argument
passed to `halve`.

<pre style="background-color:#272822;">
<code class="language-forth" data-lang="forth"><span style="color:#f92672;">: </span><span style="color:#a6e22e;">print-half </span><span style="color:#85817e;">( n -- )
  </span><span style="color:#c9d1d9;">[&#39;] halve catch if
    <b>drop</b> .&quot; </span><span style="color:#e6db74;">:(</span><span style="color:#c9d1d9;">&quot;
  else
    .
  then
</span><span style="color:#f92672;">;
</span></code></pre>

You might also wonder, what happens if someone tries to throw a `0`? Wouldn't
that be ambiguous? I suppose it wouldn't be surprising if Forth adopted a "we're
all adults here" stance here, trusting the programmer to not do that. However,
`0 throw` has been specified to be a no-op. This leads to an idiom for
conditionally throwing exceptions without an explicit `if`:

```forth
: halve ( n -- n/2 )
  dup 1 and 0<>  exn:its-odd and throw
  2/
;
```

This works since, in Forth, the canonical value for `true` has all the bits set
(unlike C, which only sets the lowest bit), so `true exn:its-odd and` evaluates
to `exn:its-odd`.

---

[^xt]: The fun thing about working with a language as old as Forth, is that
  terminology has developed that is completely different from what names the
  mainstream languages use for equivalent concepts. That is, while *execution
  token* is a perfectly fine name in isolation, everybody else calls it a
  *function pointer*, and it kinda sucks that I have to write footnotes like
  these if I want to be understood by the merely Forth-curious, while
  simultaneously avoiding odd looks from the Forth veterans. One of these days
  I'll simply write a glossary and pepper in a lot of links to it everywhere...
