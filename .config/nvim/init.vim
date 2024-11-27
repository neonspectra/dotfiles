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
set tabstop=2
set shiftwidth=2

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


"Terraform
lua << EOF
require'nvim-treesitter.configs'.setup {
  -- A list of parser names, or "all" (the five listed parsers should always be installed)
  ensure_installed = { "terraform" },

  -- Install parsers synchronously (only applied to `ensure_installed`)
  sync_install = false,

  -- Automatically install missing parsers when entering buffer
  -- Recommendation: set to false if you don't have `tree-sitter` CLI installed locally
  auto_install = false,

  -- List of parsers to ignore installing (or "all")
  ignore_install = { "all" },

  ---- If you need to change the installation directory of the parsers (see -> Advanced Setup)
  -- parser_install_dir = "/some/path/to/store/parsers", -- Remember to run vim.opt.runtimepath:append("/some/path/to/store/parsers")!

  highlight = {
    enable = true,

    -- NOTE: these are the names of the parsers and not the filetype. (for example if you want to
    -- disable highlighting for the `tex` filetype, you need to include `latex` in this list as this is
    -- the name of the parser)
    -- list of language that will be disabled
    disable = { "c", "rust" },
    -- Or use a function for more flexibility, e.g. to disable slow treesitter highlight for large files
    disable = function(lang, buf)
        local max_filesize = 100 * 1024 -- 100 KB
        local ok, stats = pcall(vim.loop.fs_stat, vim.api.nvim_buf_get_name(buf))
        if ok and stats and stats.size > max_filesize then
            return true
        end
    end,

    -- Setting this to true will run `:h syntax` and tree-sitter at the same time.
    -- Set this to `true` if you depend on 'syntax' being enabled (like for indentation).
    -- Using this option may slow down your editor, and you may see some duplicate highlights.
    -- Instead of true it can also be a list of languages
    additional_vim_regex_highlighting = false,
  },
}
EOF
