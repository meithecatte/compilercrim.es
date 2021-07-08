+++
title = "Compiling Rust is NP-hard"
date = "2021-07-07"
+++

...though it's not the flagship borrow checking that's at fault.  What I
noticed, and would like to share with you today, is that the exhaustiveness
checking performed by the Rust compiler on `match` patterns is a superset of the
[SAT] problem. <!-- more -->

## Exhaustiveness checking

Consider the following code ([playground]):

```rust
fn update_thing(old_thing: Option<Thing>, new_thing: Option<Thing>) {
    match (old_thing, new_thing) {
        (None, Some(new)) => create_thing(new),
        (Some(old), None) => delete_thing(old),
        (None, None) => { /* nothing to be done */ },
    }
}
```

As most Rustaceans already know, the compiler will reject this with the
following error:

<pre class="ansi2html-content">
<span class="ansi1"></span><span class="ansi1 ansi38-9">error[E0004]</span><span class="ansi1">: non-exhaustive patterns: `(Some(_), Some(_))` not covered</span>
 <span class="ansi1"></span><span class="ansi1 ansi38-12">--&gt; </span>example.rs:4:11
  <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
<span class="ansi1"></span><span class="ansi1 ansi38-12">4</span> <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span>    match (old_thing, new_thing) {
  <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span>          <span class="ansi1"></span><span class="ansi1 ansi38-9">^^^^^^^^^^^^^^^^^^^^^^</span> <span class="ansi1"></span><span class="ansi1 ansi38-9">pattern `(Some(_), Some(_))` not covered</span>
  <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
  <span class="ansi1"></span><span class="ansi1 ansi38-12">= </span><span class="ansi1">help</span>: ensure that all possible cases are being handled, possibly by adding wildcards or more match arms
  <span class="ansi1"></span><span class="ansi1 ansi38-12">= </span><span class="ansi1">note</span>: the matched value is of type `(Option&lt;Thing&gt;, Option&lt;Thing&gt;)`
</pre>

If you're like me, you'd eventually start wondering how this is actually
computed. What's the most efficient algorithm you can write to do this? As it
turns out, you can't do well in the worst case — and we'll prove this by a
reduction from SAT.

## Boolean satisfiability

Boolean satisfiability, or SAT for short, is the problem of determining, given
a boolean formula, whether there's a way of assigning 1 and 0 to the
variables, such that the formula evaluates to 1. For example, the formula

```c++
A and (A xor B)
```

is satisfiable, by setting `A = 1` and `B = 0`, but

```c++
A and B and (A xor B)
```

is not satisfiable.

Most algorithms for solving this problem begin by transforming it into the
*conjunctive normal form*, or simply: AND-of-ORs. That is, the formula must be
of the form

```
(_ or _ or ...) and (_ or _ or ...) and ...
```

where the `_` are filled in with variables and their negations.

Our previous example would look like this when transformed:

```c++
A and B and (A or B) and (!A or !B)
```

This is usually written as a list of constraints, where we need to pick one
option from each line without conflicts:

```
 A
    B
 A  B
!A !B
```

Obviously, every formula can be transformed into this form, by applying the
rules of Boolean algebra. To do so without an exponential blowup is a bit
harder, but we don't need to concern ourselves with the specifics.[^clausal] At
this point, the representation should look similar to a set of Rust patterns.

## Connecting the two

Thinking about the equivalence between exhaustiveness checking and
satisfiability is a *bit* tricky, as there's a negation between them at
every step of the reasoning — if a `match` is rejected, `rustc` will show us an
example value that we haven't covered, and this example is the solution to our SAT
problem. Thus, the values that match any given pattern are *rejected*. This
means that we could encode our example from the previous section like so:

```rust
match todo!() {
    (false, _)     => {}  //  A
    (_,     false) => {}  //     B
    (false, false) => {}  //  A  B
    (true,  true)  => {}  // !A !B
}
```

Let's take a closer look at the last pattern, `(true, true)`. Because of it, any
value not covered must have `false` in at least one of the variables. That's
exactly what our `!A !B` clause says.

## Some benchmarks

Upon noticing this, I couldn't *not* check how rustc compares to other SAT
solvers. The standard file format for SAT problems is [DIMACS CNF], and thanks
to Jannis Harder's [`flussab_cnf`] library, processing it was a breeze.
I'll spare you the plumbing, but the core of the converter looks like this:

```rust
/// 0-based variable index, possibly negated — `false` in the `bool` field means negated
#[derive(Clone, Copy, PartialEq, Eq)]
struct Literal(usize, bool);

fn print_clause(mut clause: Vec<Literal>, num_variables: usize) {
    let mut pattern = vec![None; num_variables];
    for Literal(var, positive) in clause {
        // We negate it here, as we need to match the assignments that *don't* satisfy
        // the clause. While not doing this would generate an equivalent instance, this
        // way the results rustc outputs directly correspond with our input.
        pattern[var] = Some(!positive);
    }

    let pattern = pattern.into_iter()
        .map(|pat| match pat {
            None => "_",
            Some(true) => "true",
            Some(false) => "false",
        })
        .join(", ");

    println!("({}) => {{}}", pattern);
}
```

I've pushed the [full code][converter] to GitHub if you want to run some
experiments yourself. I chose to try it on the first instance of `uf20-91`
from the [SATLIB benchmark problems][satlib]. This is a randomly generated
problem with 20 variables and 91 clauses. It is not by any means hard — even
my simple implementation of the basic [DPLL] algorithm solves it in less than a
millisecond.

How does rustc compare? It takes 15 seconds, and produces the following output:

<pre class="ansi2html-content">
<span class="ansi1"></span><span class="ansi1 ansi33">warning</span><span class="ansi1">: unreachable pattern</span>
  <span class="ansi1"></span><span class="ansi1 ansi38-12">--&gt; </span>test.rs:34:1
   <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
<span class="ansi1"></span><span class="ansi1 ansi38-12">34</span> <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span>(_, _, _, _, _, _, true, _, _, _, _, false, _, true, _, _, _, _, _, _) =&gt; {}
   <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span><span class="ansi1"></span><span class="ansi1 ansi33">^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^</span>
   <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
   <span class="ansi1"></span><span class="ansi1 ansi38-12">= </span><span class="ansi1">note</span>: `#[warn(unreachable_patterns)]` on by default

<span class="ansi1"></span><span class="ansi1 ansi33">warning</span><span class="ansi1">: unreachable pattern</span>
  <span class="ansi1"></span><span class="ansi1 ansi38-12">--&gt; </span>test.rs:55:1
   <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
<span class="ansi1"></span><span class="ansi1 ansi38-12">55</span> <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span>(_, _, _, _, true, _, _, true, _, _, _, false, _, _, _, _, _, _, _, _) =&gt; {}
   <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span><span class="ansi1"></span><span class="ansi1 ansi33">^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^</span>

[...]

<span class="ansi1"></span><span class="ansi1 ansi33">warning</span><span class="ansi1">: unreachable pattern</span>
  <span class="ansi1"></span><span class="ansi1 ansi38-12">--&gt; </span>test.rs:92:1
   <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
<span class="ansi1"></span><span class="ansi1 ansi38-12">92</span> <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span>(_, _, _, false, true, _, _, _, _, _, _, _, _, _, _, true, _, _, _, _) =&gt; {}
   <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span><span class="ansi1"></span><span class="ansi1 ansi33">^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^</span>

<span class="ansi1"></span><span class="ansi1 ansi38-9">error[E0004]</span><span class="ansi1">: non-exhaustive patterns: `(false, true, true, true, false, false, false, true, true, true, true, false, false, true, true, false, true, true, true, true)`, `(true, false, false, false, false, true, false, false, false, false, false, false, true, true, true, false, true, false, false, true)`, `(true, false, false, false, false, true, false, false, true, false, false, false, false, true, true, false, true, false, false, true)` and 4 more not covered</span>
 <span class="ansi1"></span><span class="ansi1 ansi38-12">--&gt; </span>test.rs:1:19
  <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
<span class="ansi1"></span><span class="ansi1 ansi38-12">1</span> <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span>fn main() { match todo!() {
  <span class="ansi1"></span><span class="ansi1 ansi38-12">| </span>                  <span class="ansi1"></span><span class="ansi1 ansi38-9">^^^^^^^</span> <span class="ansi1"></span><span class="ansi1 ansi38-9">patterns `(false, true, true, true, false, false, false, true, true, true, true, false, false, true, true, false, true, true, true, true)`, `(true, false, false, false, false, true, false, false, false, false, false, false, true, true, true, false, true, false, false, true)`, `(true, false, false, false, false, true, false, false, true, false, false, false, false, true, true, false, true, false, false, true)` and 4 more not covered</span>
  <span class="ansi1"></span><span class="ansi1 ansi38-12">|</span>
  <span class="ansi1"></span><span class="ansi1 ansi38-12">= </span><span class="ansi1">help</span>: ensure that all possible cases are being handled, possibly by adding wildcards or more match arms
  <span class="ansi1"></span><span class="ansi1 ansi38-12">= </span><span class="ansi1">note</span>: the matched value is of type `(bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool, bool)`
  <span class="ansi1"></span><span class="ansi1 ansi38-12">= </span><span class="ansi1">note</span>: this error originates in a macro (in Nightly builds, run with -Z macro-backtrace for more info)

<span class="ansi1"></span><span class="ansi1 ansi38-9">error</span><span class="ansi1">: aborting due to previous error; 17 warnings emitted</span>

<span class="ansi1">For more information about this error, try `rustc --explain E0004`.</span>

</pre>

So, unlike a basic SAT solver, it finds all the solutions and some redundant
clauses. Though, even with these features, I wouldn't call its performance
competitive :stuck_out_tongue:

## Improving the representation

If you take a look at the Rust code we produce, you'll notice that it's mostly
composed of `_`. In fact, it's size is quadratic in the size of the input SAT
problem (since the number of both clauses and variables is linear in the input
size). While that's still a polynomial, and thus the proof of NP-hardness works
out, it still feels unoptimal.

What we could do instead, is use a tree instead of a simple list:

```rust
  (bool, bool,   bool, bool,     bool, bool,   bool, bool)
(((bool, bool), (bool, bool)), ((bool, bool), (bool, bool)))
```

That way, if a branch is composed of only `_`s, we can collapse it all into a
single `_`. This makes a single clause take only `O(num_vars_in_clause log num_vars_total)`
characters, which means the entire thing is only linearithmic in the input size.

## Endsay

Does this mean that rustc should integrate an industrial-strength SAT solver?
As hilarious as that would be, I'm advocating no such thing. This will only be a
performance issue on pathological examples crafted by bored nerds, and I don't
think precious engineering time should be spent on that. Besides, generalizing a
SAT algorithm to handle the full expressive power of Rust's patterns might be,
to borrow some language from mathematicians, non-trivial.

If you found this post interesting, you might also like my other writing. I
mostly write about my [bootstrapping] project, in which I wrote a seed binary of
512 bytes, flashed it into a bootsector, and am now building up to a comfortable
environment on top of it. I suppose that makes it the smallest possible
self-hosting operating system.

Also, if you'd like to be notified about new articles, you can [follow me on
Twitter][twitter], or subscribe to the RSS feed.

Finally, SAT is a surprisingly deep and interesting field. Even though it's an
NP-complete problem, modern solvers can handle practical problems with several
thousands of variables. If you'd like to learn more, I can recommend [Knuth's
lecture on the topic][knuth], as well as [Jannis's blog series on
Varisat][varisat]. The [Handbook of Satisfiability][handbook] is good as a
reference, too.

---

[^clausal]: To be specific, [some formulas][wiki-cnf] will grow exponentially
  when converted into an equivalent CNF form. However, we don't really care
  about *equivalence*, but only *equisatisfiability* — in other words, we solve
  this by introducing additional variables to the problem. If you think of the
  input formula as a circuit of gates, add a variable for the state of every
  internal wire. Then, we can express the constraint that the output of each
  gate agrees with the inputs, separately for each gate.

[SAT]: https://en.wikipedia.org/wiki/Boolean_satisfiability_problem
[wiki-cnf]: https://en.wikipedia.org/wiki/Conjunctive_normal_form#Conversion_into_CNF
[playground]: https://play.rust-lang.org/?version=stable&mode=debug&edition=2018&gist=cab7e0bcf26b0180f15324d81009870d
[DIMACS CNF]: https://logic.pdmi.ras.ru/~basolver/dimacs.html
[`flussab_cnf`]: https://crates.io/crates/flussab-cnf
[converter]: https://github.com/NieDzejkob/rustc-sat
[satlib]: https://www.cs.ubc.ca/~hoos/SATLIB/benchm.html
[DPLL]: https://en.wikipedia.org/wiki/DPLL_algorithm
[twitter]: https://twitter.com/NieDzejkob
[bootstrapping]: @/bootstrap/_index.md
[knuth]: https://www.youtube.com/watch?v=g4lhrVPDUG0
[varisat]: https://jix.one/blog/
[handbook]: https://ebooks.iospress.nl/volume/handbook-of-satisfiability-second-edition
