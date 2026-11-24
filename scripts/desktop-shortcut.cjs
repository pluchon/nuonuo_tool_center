const { copyFileSync, constants, existsSync, readdirSync, unlinkSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { execFileSync } = require('node:child_process')
const { productName } = require('../package.json')

function syncShortcut(create) {
  const { app, shell } = require('electron')
  const root = resolve(__dirname, '..')
  const desktop = app.getPath('desktop')
  const target = join(desktop, productName + '.lnk')
  const options = {
    target: process.execPath, args: '"' + root + '"', cwd: root,
    description: productName, icon: join(root, 'resources', 'icon.ico'), iconIndex: 0
  }
  function write(operation) {
    if (!shell.writeShortcutLink(target, operation, options)) throw new Error('无法更新桌面快捷方式')
  }
  const matchesProject = (file) => {
    try {
      const link = shell.readShortcutLink(file)
      return link.target.toLowerCase() === process.execPath.toLowerCase()
        && link.args?.replace(/^"|"$/g, '').toLowerCase() === root.toLowerCase()
    } catch {
      return false
    }
  }

  if (existsSync(target)) {
    if (matchesProject(target)) write('update')
    else if (create) throw new Error('桌面上已有同名快捷方式')
    return
  }
  for (const name of readdirSync(desktop)) {
    if (!name.toLowerCase().endsWith('.lnk')) continue
    const previous = join(desktop, name)
    if (!matchesProject(previous)) continue
    // 先写好新入口，再移除旧名称。
    copyFileSync(previous, target, constants.COPYFILE_EXCL)
    write('update')
    unlinkSync(previous)
    return
  }
  if (create) write('create')
}

if (process.platform === 'win32') {
  if (process.versions.electron) {
    const { app } = require('electron')
    try {
      syncShortcut(process.argv.includes('--create'))
      app.exit(0)
    } catch (error) {
      console.error(error.message)
      app.exit(1)
    }
  } else {
    execFileSync(require('electron'), [__filename, ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit' })
  }
}
