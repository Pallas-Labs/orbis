//! A load the view shows: what came back last, whether a load runs now, and why the last one
//! failed. What shows stays up while a reload runs and after it fails.

#[derive(Debug)]
pub struct Load<T> {
    pub data: Option<T>,
    pub busy: bool,
    pub error: Option<String>,
}

impl<T> Default for Load<T> {
    fn default() -> Self {
        Load { data: None, busy: false, error: None }
    }
}

impl<T> Load<T> {
    /// A load starts.
    pub fn begin(&mut self) {
        self.busy = true;
    }

    /// A load ends. Keeps the data on success; on failure keeps what showed and returns why.
    pub fn land(&mut self, got: Result<T, String>) -> Option<String> {
        self.busy = false;
        match got {
            Ok(data) => {
                self.data = Some(data);
                self.error = None;
                None
            }
            Err(why) => {
                self.error = Some(why.clone());
                Some(why)
            }
        }
    }
}
