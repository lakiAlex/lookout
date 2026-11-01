# Third-party notices

## zsh-syntax-highlighting

`src-tauri/shell/zsh-syntax-highlighting` is zsh-syntax-highlighting 0.8.0, used unchanged to color the command line in zsh terminals. BSD 3-Clause License, see `src-tauri/shell/zsh-syntax-highlighting/COPYING.md`. https://github.com/zsh-users/zsh-syntax-highlighting

## Terminal colors

The palettes in `src/lib/terminalThemes.ts` come from iTerm2-Color-Schemes (MIT License). https://github.com/mbadolato/iTerm2-Color-Schemes

## Editor colors

The syntax colors in `src/lib/editorThemes.ts` were taken from the theme files in the tm-themes package (MIT License), which collects the VS Code themes of their authors. https://github.com/shikijs/textmate-grammars-themes

## Codicons

The sidebar icons in `src/components/Codicon.tsx` are path data from Codicons by Microsoft, licensed under the Creative Commons Attribution 4.0 International License (CC BY 4.0). https://github.com/microsoft/vscode-codicons

## xterm.js WebGL renderer

`patches/@xterm__addon-webgl.patch` changes `@xterm/addon-webgl` 0.19.0 (MIT License) so that cells with dim or italic text draw no background when the terminal background is transparent. Without it those cells get a black box. https://github.com/xtermjs/xterm.js

## File icons

`src/assets/vscicons` is the icon set of Icons - Maintained 1.2.12 by Yusif Aliyev, based on Icons by Mhammed Talhaouy, copied unmodified. MIT License, see `src/assets/vscicons/LICENSE.txt`. https://github.com/yusifaliyevpro/vscode-icons
