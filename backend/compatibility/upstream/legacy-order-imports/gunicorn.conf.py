# Private process only; never expose source WSGI diagnostics or request URLs.
bind='127.0.0.1:8127'
workers=2
threads=1
timeout=35
accesslog=None
errorlog='/dev/null'
capture_output=False
worker_tmp_dir='/tmp'
