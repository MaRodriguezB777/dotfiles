local M = {}

local files_au = vim.api.nvim_create_augroup("minifiles", { clear = true })

local files_get_path = function(buf)
  local path = vim.api.nvim_buf_get_name(buf):match("^minifiles://%d+/(.*)$")
  local stat = vim.uv.fs_stat(path)
  return path, stat
end

local get_preview_win = function()
  local MiniFiles = require("mini.files")
  if not MiniFiles.config.windows.preview then
    return
  end
  local state = MiniFiles.get_explorer_state()
  if not state then
    return
  end
  local rightmost_win = state.windows[#state.windows].win_id
  if rightmost_win == vim.api.nvim_get_current_win() then
    return
  end
  return rightmost_win
end

local preview_win_call = function(callback)
  local win = get_preview_win()
  if win then
    vim.api.nvim_win_call(win, callback)
  end
end

local toggle_preview = function()
  local MiniFiles = require("mini.files")
  local is_preview = MiniFiles.config.windows.preview
  local is_preview_next = not is_preview
  MiniFiles.config.windows.preview = is_preview_next
  MiniFiles.trim_right()
  MiniFiles.refresh({ windows = { preview = is_preview_next } })
  if is_preview then
    local branch = MiniFiles.get_explorer_state().branch
    table.remove(branch)
    MiniFiles.set_branch(branch)
  end
end

local norm_in_preview = function(keys)
  preview_win_call(function()
    local key = vim.api.nvim_replace_termcodes(keys, true, false, true)
    vim.cmd.norm({ key, bang = true })
  end)
end

local jump_edges = function()
  preview_win_call(function()
    local last = vim.fn.line(".") == vim.fn.line("$")
    vim.cmd.norm({ last and "gg" or "G", bang = true })
  end)
end

-- https://github.com/nvim-mini/mini.nvim/blob/c163117900c17d4abf30bc09452a261c8536060c/lua/mini/files.lua#L2310-L2314
local validate_file = function(path)
  local fd, _, err = vim.uv.fs_open(path, "r", 1)
  if not fd then
    return err, nil
  end
  local is_binary = vim.uv.fs_read(fd, 1024):find("\0") ~= nil
  vim.uv.fs_close(fd)
  return false, is_binary
end

local files_preview_ns = vim.api.nvim_create_namespace("minifiles")

-- ── Path copying ─────────────────────────────────────────────────────────────

local cpy_entry_path = function(entry, relative)
  if not entry then
    vim.notify("No file or directory selected", vim.log.levels.WARN)
    return
  end
  local path = "No path set"
  local prefix = ""
  if relative then
    local working_dir = vim.fn.getcwd()
    path = entry.path:gsub("^" .. working_dir .. "/", "")
    prefix = "Relative (cwd) "
  else
    path = entry.path
    prefix = "Full "
  end
  vim.fn.setreg("+", path)
  vim.notify(vim.fn.fnamemodify(path, ":t"), vim.log.levels.INFO)
  vim.notify(prefix .. "path copied to clipboard: " .. path, vim.log.levels.INFO)
end

-- ── Module setup ─────────────────────────────────────────────────────────────

function M.setup()
  local MiniFiles = require("mini.files")

  -- Global open keymaps
  local open_buf_file = function(buf)
    buf = buf or 0
    MiniFiles.open(vim.bo[buf].buftype == "" and vim.api.nvim_buf_get_name(buf) or nil, true)
  end
  -- stylua: ignore start
  -- vim.keymap.set("n", "<Leader>F",  function() MiniFiles.open() end,                        { desc = "Open files" })
  -- vim.keymap.set("n", "<Leader>.F", function() open_buf_file() end,                         { desc = "Open files (current buf)" })
  -- vim.keymap.set("n", "<Leader>@F", function() MiniFiles.open(vim.fn.getcwd()) end,         { desc = "Open files (cwd)" })
  -- vim.keymap.set("n", "<Leader>~F", function() MiniFiles.open("~") end,                     { desc = "Open files (system home)" })
  -- stylua: ignore end

  -- Set line numbers in preview window for files
  vim.api.nvim_create_autocmd("User", {
    pattern = "MiniFilesWindowUpdate",
    desc = "Define `mini.files` window options",
    group = files_au,
    callback = function(e)
      local win = e.data.win_id
      local buf = e.data.buf_id
      local _, stat = files_get_path(buf)
      if stat and stat.type ~= "directory" then
        vim.wo[win].number = true
      end
    end,
  })

  -- Resize preview dynamically
  local refresh_preview = function()
    local width_focus = MiniFiles.config.windows.width_focus
    local width_preview = MiniFiles.config.windows.width_preview
    local preview_width = math.min(vim.o.columns - width_focus - 4, width_preview)
    MiniFiles.refresh({ windows = { width_preview = preview_width } })
  end
  local resize_autocmd = function(event, opts)
    vim.api.nvim_create_autocmd(
      event,
      vim.tbl_extend("keep", opts, { desc = "Resize `mini.files` preview to be always visible", group = files_au })
    )
  end
  resize_autocmd("VimResized", { callback = refresh_preview })
  resize_autocmd("User", { pattern = "MiniFilesWindowOpen", callback = vim.schedule_wrap(refresh_preview) })

  -- Buffer-local keymaps
  vim.api.nvim_create_autocmd("User", {
    pattern = "MiniFilesBufferCreate",
    desc = "Set `mini.files` buffer keymaps",
    group = files_au,
    callback = function(e)
      local buf_id = e.data.buf_id
      local buf_map = function(mode, lhs, rhs, opts)
        opts = vim.tbl_extend("keep", opts or {}, { buffer = buf_id })
        vim.keymap.set(mode, lhs, rhs, opts)
      end

      -- Preview
      -- stylua: ignore start
      buf_map("n", "<M-p>", function() toggle_preview() end,                  { desc = "Toggle preview" })
      buf_map("n", "<C-b>", function() norm_in_preview("<C-u>") end,          { desc = "Scroll preview backwards" })
      buf_map("n", "<C-f>", function() norm_in_preview("<C-d>") end,          { desc = "Scroll preview upwards" })
      buf_map("n", "<C-g>", function() jump_edges() end,                      { desc = "Jump edges" })
      -- stylua: ignore end

      -- Telescope live grep in current directory
      buf_map("n", "S", function()
        local entry = MiniFiles.get_fs_entry()
        if entry then
          local dir = entry.fs_type == "directory" and entry.path or vim.fn.fnamemodify(entry.path, ":h")
          local reopen_path = entry.path
          MiniFiles.close()
          vim.schedule(function()
            local actions = require("telescope.actions")
            require("telescope.builtin").live_grep({
              cwd = dir,
              attach_mappings = function(_, map)
                map("n", "<Esc>", function(prompt_bufnr)
                  actions.close(prompt_bufnr)
                  MiniFiles.open(reopen_path, false)
                end)
                map("n", "q", function(prompt_bufnr)
                  actions.close(prompt_bufnr)
                  MiniFiles.open(reopen_path, false)
                end)
                return true
              end,
            })
          end)
        end
      end, { desc = "Live grep in current directory" })

      -- Copy full path
      buf_map("n", "<M-c>", function()
        cpy_entry_path(MiniFiles.get_fs_entry(), false)
      end, { noremap = true, silent = true, desc = "[Custom] Copy path to clipboard" })

      -- Copy relative path (cwd)
      buf_map("n", "<S-M-c>", function()
        cpy_entry_path(MiniFiles.get_fs_entry(), true)
      end, { noremap = true, silent = true, desc = "[Custom] Copy relative path to clipboard (cwd)" })

      buf_map("n", ".", function()
        local entry = MiniFiles.get_fs_entry()
        if entry then
          vim.api.nvim_set_current_dir(entry.path)
        end
      end, {noremap = true, silent = true, desc = "[Custom] set CWD as current directory level"})
    end,
  })

  -- Extend preview lines for scrolling support
  -- NOTE: MiniFiles limits preview to visible screen (vim.o.lines) for performance.
  --       This autocmd manually sets the full file content so scrolling keymaps work.
  vim.api.nvim_create_autocmd("User", {
    pattern = "MiniFilesBufferUpdate",
    desc = "Extend `mini.files` preview lines; adjust preview error display",
    callback = function(args)
      local buf = args.data.buf_id
      local path, stat = files_get_path(buf)
      if not stat or stat.type == "directory" then
        return
      end
      local extm_id = 1
      local error = function(msg)
        local hl = "Text"
        vim.treesitter.stop(buf)
        vim.api.nvim_buf_set_lines(buf, 0, -1, true, {})
        vim.api.nvim_buf_set_extmark(buf, files_preview_ns, 0, 0, {
          id = extm_id,
          virt_text_pos = "overlay",
          virt_text = { { msg, hl } },
        })
      end
      local warn = function(msg)
        local hl = "WarningMsg"
        vim.api.nvim_buf_set_extmark(buf, files_preview_ns, 0, 0, {
          id = extm_id,
          virt_text_pos = "right_align",
          virt_text = { { msg, hl } },
        })
      end
      local no_access, is_binary = validate_file(path)
      local format_msg = function(msg)
        msg = " " .. msg .. string.rep(" ", MiniFiles.config.windows.width_preview)
        return string.gsub(msg, " ", "-")
      end
      if no_access then
        error(format_msg("No access"))
        return
      end
      if is_binary then
        error(format_msg("Non text file"))
        return
      end
      if stat.size > 512 * 1024 then
        warn("Large file detected (>512KB)")
        return
      end
      local read_ok, read_lines = pcall(vim.fn.readfile, path, "")
      if read_ok then
        local lines = vim.split(table.concat(read_lines, "\n"), "\n")
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
      end
    end,
  })
end

return M
