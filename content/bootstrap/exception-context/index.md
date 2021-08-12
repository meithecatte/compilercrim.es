+++
title = "A better exception model for Forth"
date = "2021-08-11 12:00:01"
+++

A typical Forth system provides a simple exception handling mechanism, in which
a single integer, that identifies the exception, is thrown. If we end up
catching the exception, this scheme works reasonably well. However, if it
bubbles up to the very top and gets printed to the user, we'd like to show a bit
more context. <!-- more -->

Systems like Gforth do print the backtrace and map the integer thrown to a
textual description (in a manner similar to Unix's errno), but information
specific to a particular error is lost. For example, if an I/O error occurs,
we'd like to include the underlying error code and perhaps the block number. If
a file couldn't be found, we want its filename. So far, I couldn't find any
existing Forth system that solves this.

In this post, I describe Miniforth's solution to this problem. I build it on
top of the standard `catch` and `throw` words, so if you need a refresher on how
they behave, or would like to see how they're implemented, see [this
article of mine](@/bootstrap/throw-catch/index.md).

## Finding the printing function

The mechanism would be most flexible if the user could simply register an
arbitrary snippet of code for printing a type of exceptions. However, most of
the exceptions wouldn't actually use this flexibility fully. Therefore, the
design has two main parts:
 - locating the word that prints a given exception, and
 - syntax that makes it easy to define a printing word with typical behavior.

Locating the printing function is a very similar problem to finding the string
name for an integer error code like other systems do. As such, we *could* adapt
Gforth's solution, creating a linked list much like the dictionary itself:

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
and execution time[^time]. The pointers also serve well as opaque tokens to be
compared when we need to decide, after `catch`, whether to suppress or re-throw
a particular exception.

```forth
: print-half ( n -- )
  ['] halve catch case
    0 of ." The half is " . endof
    ['] its-odd of ." It's odd!" endof
    ( default ) throw
  endcase ;
```

Of course, throwing the execution token like that will explode violently when
someone throws a simple integer. However, if compatibility was desired, the two
schemes could be merged somehow. For example, while the integers thrown are
usually negative, a Forth system with 32-bit or wider addresses would never set
the highest bit of an address. Extending this to a higher granularity, the
system could decide whether to execute the thrown value by checking whether an
address is mapped in memory.

Another combination I'd be considering would be to reserve a single numeric
identifier in the traditional system for all "fancy" exceptions, and then store
the actual execution token in a `variable`. In this case a wrapper around
`throw` would be necessary.

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

Either way, Miniforth settles for directly throwing execution tokens — these
alternative solutions could be useful when integrating these ideas into other
systems, though.

## Defining the exceptions

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
`unknown-word` exception includes a `word:` field. But `word` is already a
well-known word that parses a token from the input stream.

### Alternative designs

Of course, this is not the only possible way of attaching context. For one, we
could change how `catch` affects the stack, and keep any values describing the
exception on the stack, just below the execution token itself. However, `throw`
purposefully resets the stack depth to what it was before `catch` was called to
make stack manipulation possible after an exception gets caught. Changing this
would introduce other problems to be solved, which is why I abandoned this
approach.

One could also consider using dynamically allocated exception structures. At
first it might seem that this is utterly pointless, as only one exception is
ever being thrown at a given time, and there isn't much point to holding onto it
for extended periods of time. This is not entirely true, as one could imagine
one exception containing a *cause* field, that would chain exceptions together:

```forth
writeback-failed
buffer-at: $1400       ( these fields come from writeback-failed itself )
caused-by: io-error    ( the printing word for caused-by executes io-error )
block-number: 13       ( these come from io-error )
error-code: $47
```

Still, a situation where two exceptions of the same type are present in a chain
of causes is somewhat far-fetched, and, in my opinion, does not justify the
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

One caveat of storing context early is that, if you're not careful, a word
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
a recursive word, your exceptions are probably needlessly general anyway.

## The implementation

Okay, so how do we implement this `exception`...`end-exception` structure? Most
of the work is actually done by `end-exception` itself. This is because we need
to generate the variables and their underlying storage, as well as the code of
the printing function, and we can't do both at once — we'd quickly end up
putting a variable's dictionary header in the middle of our code.[^skipping]

Therefore, the context variables themselves are defined first, and then
`end-exception` walks the dictionary to process all the variables after they've
been defined. For this purpose, a dictionary entry can be pointed at in two
locations:

![Diagram illustrates what is about to be described.](nt-and-xt.svg)

The *name token* (`nt` for short) points to the very beginning of the header.
This is the value stored in `latest` and the link fields, and it lets you know
as much as the name itself.[^name-token] On the other hand, we have an
*execution token* (`xt` for short), which directly points at the code of a word.
This is the value we can pass to `execute`, compile into a definition with `,`,
or in general do things where only the behavior matters. Notice that, due to the
variable-length name field, we can only turn a name token into an execution
token (`>body ( nt -- xt )`), but not the other way around.

Equipped with this knowledge, we can traverse the dictionary — `exception` saves
the value of `latest`, which is the name token of the first word that *isn't*
part of the exception context. As is typical for Forth control structures, we
can just put this value on the stack:

```forth
: exception ( -- dict-pos ) latest @ ;
```

`latest` is also read by `end-exception`, as the very first thing done.
This is because creating the printing word itself will change the value of
`latest`.

```forth
: end-exception ( dict-pos -- ) latest @ :
  ( ... )
```

Note that `:` is not an immediate word, and as such, when it gets called by
`end-exception`, it will parse out the token after `end-exception` and begin a
definition with that name.

The first thing this definition needs to do is print its own name. Since we'll
also need to print the names of other words, let's factor that out.
`print-name,` will append to the current definition (hence the `,` in the name)
the action of printing the name corresponding to a name token:

```forth
: print-name, ( nt -- )
  header-name postpone 2literal postpone type ;
```

`end-exception` then passes the *newly updated* value of `latest` to
`print-name,`:

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
pointers become equal, testing before handling each field.

```forth,hide_lines=1
: x
  begin ( end-pos cur-pos ) 2dup <> while
    dup print-field, ( follow the link field ) @
  repeat  2drop  postpone ;  ;
```

Notice how unlike `:`, the `;` that ends the definition being generated needs to
be `postpone`d. This is because `;` is marked `immediate`, unlike `:`.

So, how does `print-field,` work? It first needs to print the name itself, which
we can do with `print-name,`. But how does the value of the field get printed?
Since printing a string is very different from printing a number, the field
needs to let us know how to print it. To do so, the exception variables have an
extra field in their header, which contains the execution pointer that prints a
field of this type.

At first, it might seem like there is no room to extend the header like this,
though. We have the link field, then immediately comes the name, and when *it*
ends, there's the code. However, we can put it *to the left* of the link field:

![The print xt is directly to the left of the location the nt points to.](printing-field.svg)

As a side-effect of this layout, a normal defining word, such as `variable`, can
be invoked after the print xt is written:

```forth
: print-uint @ u. ; : uint ['] print-uint , variable ;
: print-str 2@ type ; : str ['] print-str , 2variable ;
```

This is then used by `print-field,`:

```forth
: print-field, ( nt -- )
  dup print-name, postpone space
  dup >body , ( push pointer to field )
  1 cells - @ , ( call the printing xt )
  postpone cr ;
```

This will generate roughly the following code:

```forth
s" word:" type space word: print-str cr
```

## Closing remarks

These few lines are the core of the implementation. In [the repository][repo],
you can find it in [`block13.fth`][block]. While it fits snugly within one
block, not many types are included for the context variables.

If you want to play around with it, follow the instructions in the README to
build a disk image and fire it up in QEMU. Typing `1 load` will load, among
various other code, the exception handling.

As written, this code probably won't work on other Forth systems — after all,
I'm making extensive use of the internal details of the dictionary. If I were to
write this with a focus on portability, I'd probably end up using a separate
linked list to store pairs of `(variable_nt, printing_xt)`. Not sure if there is
a standard word for getting the name out of a name token, though.

{{ get_notified() }}

---

[^time]: Though, the time factor probably won't matter — printing exceptions is
  far from a hot spot.

[^skipping]: We *could* try jumping over these headers, but at that point it
  doesn't look like it's simplifying anything.

[^name-token]: Or rather, even more than what the name itself can tell you, as
  if a future definition with the same name shadows this one, the name token
  will still point to the same word.

[repo]: https://github.com/NieDzejkob/miniforth
[block]: https://github.com/NieDzejkob/miniforth/blob/master/block13.fth
