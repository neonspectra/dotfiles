" homerow typers stay mad
noremap a h
noremap s j
noremap w k
noremap d l
noremap v w
noremap y b
inoremap qq <Esc>

" (e)nsert
noremap e a
noremap E A

" spaces > tabs
set expandtab

" nano is love, nano is life
noremap k d
noremap <C-v> <C-d>
noremap <C-y> <C-u>
noremap <C-a> 0
noremap <C-e> $
noremap <BS> X

" other

" h to start visual line since I use v to scroll
noremap h v
" Rebind yank to j since I use y to scroll
noremap j y
" Remove binding from q since it's used for esc, and rebind it to (l)isten
map q <Nop>
noremap l q

" insert single character without leaving normal mode
noremap <silent> <space> :exe "normal i".nr2char(getchar())<CR>
" insert a newline without leaving normal mode
noremap <CR> o<Esc>

" spelling
set spelllang=en_gb
"" Starts spellcheck
noremap <F3> :set spell!<CR>
"" See suggestions
noremap <F4> z=
"" Add to dictionary
noremap <F5> zg

" Load packer
lua require('plugins')

" Hop
noremap ff :HopWord<CR>
noremap fe :HopLineStart<CR>
noremap fv :HopVertical<CR>
noremap fg :HopChar1<CR>
noremap fgg :HopChar2<CR>
noremap f/ :HopPattern<CR>

" Disable mouse
set mouse=
