+++
title = "Contextful exceptions with Forth metaprogramming"
date = "2021-09-20 12:00:01"
+++

A typical Forth system provides a simple exception handling mechanism, in which
a single integer, that identifies the exception, is thrown. If we end up
catching the exception, this scheme works reasonably well. However, if it
bubbles up to the very top and gets printed to the user, we'd like to show a bit
more context. <!-- more -->

Systems like Gforth do print the backtrace and map the integer thrown to a
textual description (in a manner similar to Unix's errno), but information
specific to a particular error is lost. For example, if an I/O error occurs,
we'd like to include the underlying error code, the block number, and perhaps
some device identifier. If a file couldn't be found, we want its filename. So
far, I couldn't find any existing Forth system that solves this.

In this post, I describe Miniforth's solution to this problem. We'll build a
simple extension to the `throw`-and-`catch` mechanism to allow error messages
like:

```
i/o-error
in-block: 13
error-code: 2
```
```
unknown-word
word: has-typpo
```

The latter example also illustrates why exceptions are on the critical path of
the bootstrap — they'll be the mechanism by which the new outer interpreter
reports unknown words. Granted, we could hack around this need, but some form of
unwinding will be necessary anyway, as the error may occur within a parsing word
like `'`, potentially deep within the user's program.

Older Forth systems used a simpler strategy of `abort`ing into the top-level
REPL upon the first error, which entailed clearing the return stack entirely and
jumping to the entrypoint of the system. I decided that this simplification is
not worth it, as I'll eventually need the full flexibility of exceptions —
planning ahead, I'm modeling the eventual text editor after `vi`, and I'm
considering making the commandline bound to `:` a Forth REPL (with an additional
vocabulary activated for the commands specific to editing text). In that case,
quitting the editor after the first typo wouldn't be very nice.

The mechanism I describe here is built it on top of the standard `catch` and
`throw` words, so if you need a refresher on how they behave, or would like to
see how they're implemented, see [this article of mine](@/bootstrap/throw-catch/index.md).

## The design

The mechanism would be most flexible if the user could simply register an
arbitrary snippet of code for printing an exception type. However, most of
the exceptions wouldn't actually use this flexibility fully. Therefore, the
design has two main parts:
 - locating the word that prints a given exception, and
 - syntax for defining a typical printing word easily.

### Finding the printing function

Locating the printing handler is a very similar problem to finding a *string*
description, which is something other systems do. As such, we *could* adapt
Gforth's solution, creating a linked list much like the dictionary itself,
mapping exception numbers to printing routines:

![A linked list with entries consisting of a link field, exception number and
the code executed for a given exception.](gforth-like.svg)

An explicit mapping like that could indeed be the best way of locating the
printing word, if one was looking for compatibility with existing programs
throwing integers willy-nilly. However, that is not a goal for Miniforth,
which allows a simpler solution — directly throw the pointer to the printing
function.

```forth
: my-exn ." Hello!" cr ;
' my-exn throw ( prints Hello! )
```

That way, no extra data structures are necessary, saving both memory
and execution time[^time]. Even when you don't want to print the exception, but,
for example, check if the exception you've caught is one you want to handle,
nothing stopping you from comparing these pointers like opaque tokens.

```forth
: print-half ( n -- )
  ['] halve catch case
    0 of ." The half is " . endof
    ['] its-odd of ." It's odd!" endof
    ( default ) throw
  endcase ;
```

Of course, throwing the execution token like that will explode violently when
someone throws a simple integer. If compatibility was desired, the two schemes
could be merged somehow. The solution I like the most here is to reserve a
single numeric identifier in the traditional system for all "fancy" exceptions,
and then store the actual execution token in a `variable`. In this case a
wrapper around `throw` would be necessary, but we can use this opportunity to
merge the `[']` into it too:

```forth
variable exn-xt
-123 constant exn:fancy
: (throw-fancy) exn-xt ! exn:fancy throw ;
: [throw]  postpone ['] postpone (throw-fancy) ; immediate
( usage: )
: halve dup 1 and if
    [throw] its-odd
  then 2/ ;
```

Either way, Miniforth settles for directly throwing execution tokens — this
alternative could be useful when integrating these ideas into other systems,
though.

### Defining the exceptions

To make defining the exceptions easier, Miniforth provides this syntax:

```forth
exception
  str string-field:
  uint integer-field:
end-exception my-exception
```

This creates the variables `string-field:` and `integer-field:`, and a word
`my-exception` that prints its name and the values of all the fields:

```
my-exception
integer-field: 42
string-field: hello
```

As you can see, the naming convention of ending exception fields with a `:` also
serves to separate names from values when the exception gets printed.  While it
wouldn't be hard to make the code add a `:` by itself, I don't think that would
be for the better — the naming convention means you don't have to worry about
your field names conflicting with other Forth words. For example, the
`unknown-word` exception includes a `word:` field, but `word` is already a
well-known word that parses a token from the input stream. I must admit that I
first considered much more complicated namespacing ideas before realizing that
the colon can serve as a naming convention.

### Alternative designs

Of course, this is not the only possible way of attaching context. For one, we
could change how `catch` affects the stack, and keep any values describing the
exception on the stack, just below the execution token itself. However, `throw`
purposefully resets the stack depth to what it was before `catch` was called to
make stack manipulation possible after an exception gets caught. While you
could, instead, keep track of the size of the exception being handled and manage
the stack appropriately, I can't imagine that being pleasant.

One could also consider using dynamically allocated exception structures. After
all, that's pretty much what higher-level languages do. However, there is no
point in holding onto an exception for later, and only one exception is ever
being thrown at a given time. I do admit that one could chain exceptions
together by having a *cause* field, like so:

```forth
writeback-failed
buffer-at: $1400
caused-by:
  io-error
  block-number: 13
  error-code: $47
```

Still, a situation where two exceptions of the same type are present in a causal
chain is somewhat far-fetched, and, in my opinion, does not justify the
increased complexity — making this work would need a dynamic allocator and
a destructor mechanism for the exception objects.

In the end, storing context in global variables has a very nice advantage: the
context can be speculatively recorded when convenient. This is best illustrated
by an example, so let's take a look at `must-find`, which turns the
zero-is-failure interface of `find` into an exception-oriented one. The
implementation stores its input string into `word:` before calling `find`,
regardless of whether the exception will actually be thrown or not:

```forth
: find ( str len -- nt | 0 ) ... ;
: must-find ( str len -- nt ) 2dup word: 2! find
  dup 0= ['] unknown-word and throw ;
```

If we had to keep it on the stack instead, the code would need a separate code
path for the happy case afterwards, to discard the no-longer-needed context:

```forth
: must-find ( str len -- nt ) 2dup find
  dup if
    >r 2drop r>
  else
    word: 2! ['] unknown-word throw
  then ;
```

This strategy does have the caveat that, if you're not careful, a word
invoked between storing the context and throwing the exception could overwrite
said context, i.e.

```forth
: inner  s" its-inner" ctx: 2!  ['] exn maybe-throw ;
: outer  s" its-outer" ctx: 2!  inner  ['] exn maybe-throw ;
( even when outer throws the exception, ctx: contains "its-inner" )
```

This is not a big issue in practice, though, as most often the definition of the
exception and all the words that throw it are directly next to each other, so
it's easy to notice if this can happen. I suppose recursion would have the
highest chance of triggering this. If this issue occurs in a context other than
a recursive word, your exceptions are probably needlessly general anyway, and
should be split into more granular types.

## The implementation

Okay, so how do we implement this `exception`...`end-exception` structure? Most
of the work is actually done by `end-exception` itself. This is because we need
to generate the variables with their underlying storage, as well as the code of
the printing function of the exception, and we can't do both at once — we'd
quickly end up putting a variable's dictionary header in the middle of our
code.[^skipping]

Therefore, the context variables themselves are defined first, and then
`end-exception` *walks through the dictionary* to process all the variables,
after they've been defined.

While traversing the dictionary, we can point at an entry in two places:

![Diagram illustrates what is about to be described.](nt-and-xt.svg)

The *name token* (`nt` for short) points to the very beginning of the header.
This is the value stored in `latest` and the link fields, and it lets you know
as much as the name of the word itself.[^name-token] On the other hand, we have an
*execution token* (`xt` for short), which directly points at the code of a word.
This is the value we can pass to `execute`, compile into a definition with `,`,
or in general do things where only the behavior matters. Notice that, due to the
variable-length name field, we can only turn a name token into an execution
token (which is what `>xt ( nt -- xt )` does), but not the other way around.

As we need to know when to stop our traversal, `exception` remembers the value of
`latest`, thus saving the name token of the first word that *isn't* part of the
exception context. Along the same lines as `if` or `begin`, we can just put
this value on the stack:

```forth
: exception ( -- dict-pos ) latest @ ;
```

`end-exception` also begins by sampling `latest`, thus establishing the other
end of the range through which we'll be iterating. Then, `:` is ran to parse the
name that comes after `end-exception`, and create an appropriate word header.

```forth
: end-exception ( dict-pos -- ) latest @ :
  ( ... )
```

One repeating operation the printing word needs to do is printing the name of
some word — either the exception name itself, or one of the variables. Let's
factor that out into `print-name,`, which takes a name token, resolves it into a
name with `>name`, and compiles the action of printing this name.

```forth
: print-name, ( nt -- )
  >name postpone 2literal postpone type ;
```

We can then use it to print the name which `:` just parsed:

```forth
: end-exception ( dict-pos -- ) latest @ :
  latest @ print-name,  postpone cr
```

Here's a diagram that visualizes the points in the dictionary where the various
pointers we got so far point to:

![The three values read from latest so far point to: the
last word defined before the exception, the last field of the exception, and
the printing word.](end-exception-latest.svg)

The next step is to iterate over the dictionary and handle all the fields. As
you can see from the diagram above, we need to stop iterating once the two
pointers become equal, testing *before* handling each field.

```forth,hide_lines=1
: x
  begin ( end-pos cur-pos ) 2dup <> while
    dup print-field, ( we'll see print-field, later )
    ( follow the link field: ) @
  repeat  2drop
```

Finally, we finish the printing word with a `;`. We need to postpone it, since
it would otherwise end the definition of `end-exception` itself.

```forth,hide_lines=1
: x
  postpone ;
;
```

So, how does `print-field,` work? It first needs to print the name itself, which
we can do with `print-name,`. But how does the value of the field get shown?

Since printing a string is very different from printing a number, the field
needs to somehow let us know how to print it. To do so, the exception variables have an
extra field in their header that points to a word such as `: print-uint @ u. ;`.

At first, it might seem like there is no room to extend the header like this,
though. We have the link field, then immediately comes the name, and when *it*
ends, there's the code. However, we can put it *to the left* of the link field:

![The print xt is directly to the left of the location the nt points to.](printing-field.svg)

As a side-effect of this layout, we don't actually need to write the entire
header ourselves. After our additional field is written, we can just invoke
`variable` or a similar defining word and have it complete the rest:

```forth
: print-uint @ u. ; : uint ['] print-uint , variable ;
: print-str 2@ type ; : str ['] print-str , 2variable ;
```

This is then used by `print-field,`. For a string variable called `word:`, it
will generate the following code:

```forth
s" word:" type space word: print-str cr
```

Here's how you go about generating that:

```forth
: print-field, ( nt -- )
  dup print-name, postpone space
  dup >xt ,                     ( e.g. word: )
  1 cells - @ ,                   ( e.g. print-str )
  postpone cr ;
```

This concludes the crux of the implementation. The only thing that remains is to
put an `execute` in the exception handling code of the interpreter, which we'll
soon do when we pivot into the pure-Forth outer interpreter.

In fact, the code is there already in [the GitHub repository][repo], with the
code from this article in [`block14.fth`][block] and the new outer interpreter
in blocks 20–21. If you want to play around with it, follow the instructions in
the README to build a disk image and fire it up in QEMU. Typing `1 load` will
load, among various other code, the new interpreter and exception handling.

If you like what you see, feel free to adapt this exception mechanism to your
Forth system. Though, the code probably won't work exactly as written — after
all, I'm making extensive use of the internal details of the dictionary. If I
were to write this with a focus on portability, I'd probably end up using a
separate linked list to store pairs of `(variable_nt, printing_xt)` (and words
like `uint` would be extending it).

And even if you're not going to be adding context to your exceptions, I hope
you've found this to be an interesting demonstration of Forth's metaprogramming
capabilities.

{{ get_notified() }}

---

[^time]: Though, the time factor probably won't matter — printing exceptions is
  far from a hot spot.

[^skipping]: We *could* try jumping over these headers, but at that point it
  doesn't look like it's simplifying anything.

[^name-token]: Or rather, even more than what the name itself can tell you, as
  if a future definition with the same name shadows this one, the name token
  will still point to the same word.

[repo]: https://github.com/meithecatte/miniforth
[block]: https://github.com/meithecatte/miniforth/blob/master/block13.fth
