window.addEventListener('load', function() {
    for (const ref of document.getElementsByClassName('footnote-reference')) {
        const hash = ref.children[0].hash.substring(1);
        const refhash = 'ref:' + hash;
        ref.id = refhash;
    }

    for (const footnote of document.getElementsByClassName('footnote-definition')) {
        const hash = footnote.id;
        const refhash = 'ref:' + hash;
        const backlink = document.createElement('a');
        backlink.href = '#' + refhash;
        backlink.className = 'footnote-backlink';
        backlink.innerText = '↩';
        const paras = footnote.children;
        const lastPara = paras[paras.length - 1];
        lastPara.appendChild(backlink);
    }

    let visibleSections = [];
    function activeLink() {
        const section = visibleSections.find(x => x);
        if (section !== undefined) {
            const id = section.children[0].id;
            if (id) {
                return document.querySelector(`nav li a[href$="#${id}"]`).parentElement;
            }
        }
    }

    const observer = new IntersectionObserver(entries => {
        const oldLink = activeLink();
        entries.forEach(entry => {
            const order = entry.target.getAttribute('data-order');
            if (entry.isIntersecting) {
                visibleSections[order] = entry.target;
            } else {
                visibleSections[order] = null;
            }
        });
        const newLink = activeLink();

        if (newLink !== oldLink) {
            if (oldLink) oldLink.classList.remove('active');
            if (newLink) newLink.classList.add('active');
        }
    }, {rootMargin: '-100px'});

    let i = 0;
    for (const section of document.getElementsByTagName('section')) {
        section.setAttribute('data-order', i); i += 1;
        observer.observe(section);
    }
});
