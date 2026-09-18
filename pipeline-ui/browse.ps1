Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "Chọn Thư Mục Dự Án"
$f.ShowNewFolderButton = $true
# Use a hidden dummy form as owner so it is guaranteed to be foreground
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$res = $f.ShowDialog($form)
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $f.SelectedPath
}
