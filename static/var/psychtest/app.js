// https://stackoverflow.com/a/2450976/5863987
function shuffle(array) {
  let currentIndex = array.length;

  // While there remain elements to shuffle...
  while (currentIndex != 0) {

    // Pick a remaining element...
    let randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex], array[currentIndex]];
  }
}

function pad(n) {
    return ('0'.repeat(3) + n).substr(-3);
}

const NUMS_BELOW = 1000;
const haystack_width = 10;
const haystack_height = 9;
const needles_width = 5;
const needles_height = 7;
let needles;
let haystack;
let haystackCrossed;
let startTime;

function makeTable(container, numbers, width, handler) {
    let table = document.getElementById(container);
    table.innerHTML = '';
    for (let i = 0; i < numbers.length; i += width) {
        let row = document.createElement('tr');
        for (let j = i; j < i + width; j++) {
            let td = document.createElement('td');
            td.innerText = pad(numbers[j]);
            td.onclick = handler(j);
            row.appendChild(td);
        }

        table.appendChild(row);
    }
}

function generateHaystack() {
    haystackCrossed = new Set;

    let allNumbers = [...Array(NUMS_BELOW).keys()];
    shuffle(allNumbers);
    haystack = allNumbers.slice(0, haystack_width * haystack_height);
    needles = haystack.slice(0, needles_width * needles_height);
    shuffle(haystack);

    makeTable('haystack', haystack, haystack_width, idx => ev => {
        ev.target.classList.toggle('crossout');

        if (ev.target.classList.contains('crossout')) {
            haystackCrossed.add(haystack[idx]);
        } else {
            haystackCrossed.delete(haystack[idx]);
        }
    });

    makeTable('needles', needles, needles_width, idx => ev => {
        ev.target.classList.toggle('crossout');

        if (document.querySelectorAll('#needles td:not(.crossout)').length == 0) {
            document.getElementById('finish').style.display = null;
        }
    });
}

let pages = ['haystack', 'needles_page', 'instructions', 'results_page'];
let currentPage;

function showPage(name) {
    for (let page of pages) {
        document.getElementById(page).style.display =
            page == name ? null : 'none';
    }
}

function swapPages() {
    showPage(pages[currentPage ^= 1]);
}

function handleKey(ev) {
    if (ev.keyCode == 9) {
        swapPages();
        ev.preventDefault();
    }
}

function startGame() {
    currentPage = 0;
    startTime = performance.now();
    document.getElementById('finish').style.display = 'none';
    document.getElementById('finish').addEventListener('click', showResults);
    generateHaystack();
    swapPages();

    window.addEventListener('keydown', handleKey);
    setTimeout(showResults, 180000);
}

function showResults() {
    window.removeEventListener('keydown', handleKey);
    let crossedCorrectly = 0;
    for (let n of needles) {
        if (haystackCrossed.has(n)) crossedCorrectly++;
    }

    let crossedWrong = haystackCrossed.size - crossedCorrectly;
    let correctPercent = Math.floor(crossedCorrectly / needles.length * 100);
    let timeTaken = performance.now() - startTime + 500;
    let sec = Math.floor(timeTaken / 1000);
    let min = Math.floor(sec / 60); sec %= 60;
    sec = ('0' + sec).substr(-2);
    let results =
    `Poprawnie wykreślono: <b>${crossedCorrectly} z ${needles.length} (${correctPercent}%)</b><br>
    Liczba błędów: <b id="numwrong">${crossedWrong}</b><br>
    Wykorzystany czas: <b>${min}:${sec}</b>`;
    document.getElementById('results').innerHTML = results;
    if (crossedWrong) {
        document.getElementById('numwrong').style.color = 'red';
    }

    showPage('results_page');
    document.getElementById('again').disabled = true;
    setTimeout(() => document.getElementById('again').disabled = false, 3000);
}

showPage('instructions');
document.getElementById('start').addEventListener('click', startGame);
document.getElementById('again').addEventListener('click', startGame);
