# Curilo hackathon presentation

Open `index.html` directly in a browser. The presentation is a self-contained HTML file with no build step, network requests, fonts to download, or runtime dependencies. Allow about six minutes for the 11 slides.

- **Left / Right** or **Page Up / Page Down**: previous / next slide.
- **Space**: next slide. **Home / End**: first / last slide.
- **O**: slide overview. **Escape**: close the overview.
- **N**: speaker notes, suggested timing, and repository source links.
- **F**: toggle fullscreen. The browser’s fullscreen command also works.
- On a touch screen, swipe horizontally to change slides. Tall slides scroll vertically.
- Slide 8 has a five-stage interactive request walkthrough. It explains the system without calling a live backend.
- Browser **Print / Save as PDF** prints all slides in 16:9 landscape. Enable background graphics if your browser requires it.
- Link directly to a slide using `index.html#slide-6`.

The narrative emphasizes the personal/family compute assumption, local execution with cloud intelligence, hero feature directions, the POC infrastructure, and future work on security enforcement, latency, system error recovery, and agent-led management. Speaker notes distinguish the current implementation from the target design and link to the repository evidence. Validation claims refer to the recorded results in `../VALIDATION.md`.

Edit the slide sections, embedded styles, and speaker-note templates in `index.html`. The walkthrough text lives in the `steps` array in the embedded script. Keep this folder in the repository for the relative source links to work.
